//! speechd — a local Speechmatics real-time-protocol endpoint.
//!
//! The Circle web frontend's sensory lane speaks the Speechmatics RT
//! WebSocket protocol (`StartRecognition` → binary PCM frames →
//! `AddTranscript`/`AddPartialTranscript`). In the native shell this server
//! binds 127.0.0.1 and terminates that protocol locally, so audio never has
//! to leave the device:
//!
//! - `Engine::Upstream(url)` relays the session to a configured downstream
//!   RT endpoint — a Speechmatics On-Device service bridge, an on-prem
//!   Speechmatics appliance, or any engine speaking the same protocol.
//! - `Engine::None` answers `StartRecognition` with a Speechmatics-style
//!   `Error` message; the client falls back to its in-webview sherpa lane.

use std::net::SocketAddr;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// Where a speech session's audio is transcribed.
#[derive(Clone, Debug)]
pub enum Engine {
    /// No local engine — session is refused with an Error frame.
    None,
    /// Relay to a downstream RT-protocol endpoint (on-prem appliance,
    /// On-Device service bridge, or any compatible engine).
    Upstream(String),
}

/// Resolve the engine from the process environment.
/// `CIC_SPEECH_UPSTREAM=ws://127.0.0.1:9000` (or wss://…) selects relay mode.
pub fn engine_from_env() -> Engine {
    match std::env::var("CIC_SPEECH_UPSTREAM") {
        Ok(url) if url.starts_with("ws://") || url.starts_with("wss://") => Engine::Upstream(url),
        _ => Engine::None,
    }
}

/// Bound server handle — `endpoint()` is what the webview is told to use.
pub struct Handle {
    addr: SocketAddr,
    engine: Engine,
    shutdown: mpsc::Sender<()>,
}

impl Handle {
    /// The ws:// endpoint the webview should use. Always bound — even with
    /// no engine it refuses sessions cleanly, which is how the client learns
    /// to stay on its sherpa lane.
    pub fn endpoint(&self) -> String {
        format!("ws://{}", self.addr)
    }
    pub fn engine(&self) -> &Engine {
        &self.engine
    }
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(()).await;
    }
}

type Ws = WebSocketStream<TcpStream>;

/// Bind 127.0.0.1 on an ephemeral port and serve until `Handle::shutdown`.
pub async fn start(engine: Engine) -> std::io::Result<Handle> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let (tx, mut rx) = mpsc::channel::<()>(1);
    let engine = Arc::new(engine);
    let eng = engine.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = rx.recv() => break,
                accept = listener.accept() => {
                    let Ok((stream, _)) = accept else { continue };
                    let eng = eng.clone();
                    tokio::spawn(async move {
                        if let Ok(ws) = tokio_tungstenite::accept_async(stream).await {
                            let _ = session(ws, eng).await;
                        }
                    });
                }
            }
        }
    });
    Ok(Handle {
        addr,
        engine: (*engine).clone(),
        shutdown: tx,
    })
}

/// One RT session: StartRecognition → audio frames → transcript events out.
async fn session(mut ws: Ws, engine: Arc<Engine>) -> Result<(), Box<dyn std::error::Error>> {
    // first meaningful frame must be StartRecognition
    let start = loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t)?;
                if v.get("message").and_then(Value::as_str) == Some("StartRecognition") {
                    break v;
                }
            }
            Some(Ok(_)) => continue,
            _ => return Ok(()),
        }
    };

    match engine.as_ref() {
        Engine::None => {
            ws.send(Message::Text(
                json!({ "message": "Error", "type": "engine_unavailable",
                        "reason": "no speech engine configured" })
                .to_string()
                .into(),
            ))
            .await?;
            Ok(())
        }
        Engine::Upstream(url) => relay(ws, url, start).await,
    }
}

/// Relay the session to a downstream RT endpoint. The client's
/// StartRecognition is forwarded verbatim and upstream's RecognitionStarted
/// (or Error) comes back untouched — a true protocol relay, so extensions
/// like diarization config and audio events pass transparently.
async fn relay(
    mut ws: Ws,
    upstream_url: &str,
    start: Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let (upstream, _) = match tokio_tungstenite::connect_async(upstream_url).await {
        Ok(pair) => pair,
        Err(e) => {
            ws.send(Message::Text(
                json!({ "message": "Error", "type": "engine_unavailable",
                        "reason": format!("upstream unreachable: {e}") })
                .to_string()
                .into(),
            ))
            .await?;
            return Ok(());
        }
    };

    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut down_tx, mut down_rx) = ws.split();

    // client → upstream
    let c2u = tokio::spawn(async move {
        let _ = up_tx
            .send(Message::Text(serde_json::to_string(&start).unwrap().into()))
            .await;
        while let Some(Ok(msg)) = down_rx.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
            if up_tx.send(msg).await.is_err() {
                break;
            }
        }
        let _ = up_tx.send(Message::Close(None)).await;
    });

    // upstream → client (terminates session when upstream closes)
    while let Some(msg) = up_rx.next().await {
        match msg {
            Ok(m @ (Message::Text(_) | Message::Binary(_))) => {
                if down_tx.send(m).await.is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }
    c2u.abort();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as WsMsg;

    fn start_rec() -> WsMsg {
        WsMsg::Text(
            json!({
                "message": "StartRecognition",
                "audio_format": { "type": "raw", "encoding": "pcm_s16le", "sample_rate": 16000 },
                "transcription_config": { "language": "en", "diarization": "speaker" }
            })
            .to_string()
            .into(),
        )
    }

    #[tokio::test]
    async fn engineless_session_refuses_with_error() {
        let h = start(Engine::None).await.unwrap();
        let ep = h.endpoint();
        let (mut ws, _) = tokio_tungstenite::connect_async(&ep).await.unwrap();
        ws.send(start_rec()).await.unwrap();
        let msg = ws.next().await.unwrap().unwrap();
        let v: Value = serde_json::from_str(&msg.to_string()).unwrap();
        assert_eq!(v["message"], "Error");
        assert_eq!(v["type"], "engine_unavailable");
        h.shutdown().await;
    }

    /// Mock upstream: echoes RecognitionStarted, counts audio frames,
    /// replies EndOfTranscript on EndOfStream.
    async fn mock_upstream() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut audios = 0u32;
            while let Some(Ok(msg)) = ws.next().await {
                match msg {
                    WsMsg::Text(t) => {
                        let v: Value = serde_json::from_str(&t).unwrap();
                        match v["message"].as_str().unwrap() {
                            "StartRecognition" => {
                                // diarization config must survive verbatim
                                assert_eq!(v["transcription_config"]["diarization"], "speaker");
                                ws.send(WsMsg::Text(
                                    json!({"message":"RecognitionStarted","id":"up-1"}).to_string().into(),
                                ))
                                .await
                                .unwrap();
                            }
                            "EndOfStream" => {
                                ws.send(WsMsg::Text(
                                    json!({"message":"AudioAdded","seq_no":audios}).to_string().into(),
                                ))
                                .await
                                .unwrap();
                                ws.send(WsMsg::Text(
                                    json!({"message":"EndOfTranscript"}).to_string().into(),
                                ))
                                .await
                                .unwrap();
                                break;
                            }
                            _ => {}
                        }
                    }
                    WsMsg::Binary(_) => audios += 1,
                    _ => {}
                }
            }
        });
        format!("ws://{addr}")
    }

    #[tokio::test]
    async fn upstream_relay_is_transparent_both_ways() {
        let upstream = mock_upstream().await;
        let h = start(Engine::Upstream(upstream)).await.unwrap();
        let (mut ws, _) = tokio_tungstenite::connect_async(h.endpoint()).await.unwrap();

        ws.send(start_rec()).await.unwrap();
        let v: Value =
            serde_json::from_str(&ws.next().await.unwrap().unwrap().to_string()).unwrap();
        assert_eq!(v["message"], "RecognitionStarted");
        assert_eq!(v["id"], "up-1"); // upstream's own frame, not synthesized

        ws.send(WsMsg::Binary(vec![0u8; 320].into())).await.unwrap();
        ws.send(WsMsg::Binary(vec![0u8; 320].into())).await.unwrap();
        ws.send(WsMsg::Text(
            json!({"message":"EndOfStream","last_seq_no":2}).to_string().into(),
        ))
        .await
        .unwrap();

        let v: Value =
            serde_json::from_str(&ws.next().await.unwrap().unwrap().to_string()).unwrap();
        assert_eq!(v["message"], "AudioAdded");
        assert_eq!(v["seq_no"], 2);
        let v: Value =
            serde_json::from_str(&ws.next().await.unwrap().unwrap().to_string()).unwrap();
        assert_eq!(v["message"], "EndOfTranscript");
        h.shutdown().await;
    }

    #[tokio::test]
    async fn unreachable_upstream_reports_engine_unavailable() {
        // nothing listens on this port
        let h = start(Engine::Upstream("ws://127.0.0.1:1".into())).await.unwrap();
        let (mut ws, _) = tokio_tungstenite::connect_async(h.endpoint()).await.unwrap();
        ws.send(start_rec()).await.unwrap();
        let v: Value =
            serde_json::from_str(&ws.next().await.unwrap().unwrap().to_string()).unwrap();
        assert_eq!(v["message"], "Error");
        assert_eq!(v["type"], "engine_unavailable");
        h.shutdown().await;
    }
}
