//! Circle native shell — Tauri host for the production web frontend.
//!
//! Everything the web app does runs identically inside the webview
//! (P2P media, E2EE, sherpa STT, wllama Milo). What the shell adds is a
//! local surface the web can't provide:
//!
//! - `speech_endpoint`: an on-device Speechmatics-RT endpoint (speechd),
//!   so paid-grade diarized transcription can run without audio leaving
//!   the machine. `CIC_SPEECH_UPSTREAM` selects the engine (on-prem
//!   appliance, On-Device SDK service bridge, compatible RT engine).
//! - deep links: `circle://` + registered https links hand room URLs to
//!   a single running instance.

use tauri::Manager;

struct SpeechdState {
    endpoint: String,
}

/// The ws:// endpoint of the in-process speech server. The webview prefers
/// this over cloud relays when present — direct-connect RT protocol.
#[tauri::command]
fn speech_endpoint(state: tauri::State<'_, SpeechdState>) -> String {
    state.endpoint.clone()
}

/// WebKitGTK ships WebRTC compiled in but gated behind the `enable-webrtc`
/// runtime setting, which wry leaves off. Flip it before page JS runs so
/// RTCPeerConnection/data channels are real in the shell, then navigate
/// again so the new setting reaches the page's script context.
#[cfg(target_os = "linux")]
fn enable_webrtc(app: &tauri::App) {
    use tauri::Manager;
    use webkit2gtk::{SettingsExt, WebViewExt};
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.with_webview(move |platform| {
            let wv = platform.inner();
            if let Some(s) = wv.settings() {
                s.set_enable_webrtc(true);
                s.set_enable_media_stream(true);
            }
            // reload() is a no-op before the first navigation commits;
            // load_uri re-navigates so the new context sees the setting.
            wv.load_uri("tauri://localhost");
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let engine = speechd::engine_from_env();
    let handle = rt
        .block_on(speechd::start(engine))
        .expect("speechd bind failed");
    let endpoint = handle.endpoint();
    let state = SpeechdState { endpoint };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // second launch (e.g. invite link) focuses the running window
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            enable_webrtc(app);
            Ok(())
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![speech_endpoint])
        .run(tauri::generate_context!())
        .expect("error while running circle");
}
