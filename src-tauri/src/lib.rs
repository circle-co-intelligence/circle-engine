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
    // CIC_WEB_URL points the shell at a different frontend (e.g. a Pages
    // preview deployment); defaults to the configured production site.
    let env_url = std::env::var("CIC_WEB_URL").ok();
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.with_webview(move |platform| {
            let wv = platform.inner();
            if let Some(s) = wv.settings() {
                s.set_enable_webrtc(true);
                s.set_enable_media_stream(true);
                // lets WEBKIT_INSPECTOR_SERVER=<ip:port> attach targets for
                // debugging; without the env var no inspector ever starts
                s.set_enable_developer_extras(true);
                // page console → stderr so load/JS failures are visible in
                // logs without an inspector
                s.set_enable_write_console_messages_to_stdout(true);
                // CIC_MOCK_CAPTURE=1 swaps cam/mic for synthesized devices —
                // automated two-peer tests run without hardware or prompts
                if std::env::var_os("CIC_MOCK_CAPTURE").is_some() {
                    s.set_enable_mock_capture_devices(true);
                }
            }
            // reload() is a no-op before the first navigation commits;
            // re-load the current URI so the new context sees the setting.
            let current = wv.uri().map(|u| u.to_string()).unwrap_or_default();
            let target = env_url.as_deref().unwrap_or(current.as_str());
            if !target.is_empty() && !target.starts_with("about:") {
                wv.load_uri(target);
            }
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
            // CIC_AUTOJOIN=1: periodically submit the room join form so
            // headless/two-peer test harnesses can get the shell seated
            // without synthetic input events
            if std::env::var_os("CIC_AUTOJOIN").is_some() {
                if let Some(win) = app.get_webview_window("main") {
                    tauri::async_runtime::spawn(async move {
                        let js = r#"(() => {
                            const inp = document.querySelector('input');
                            const btn = [...document.querySelectorAll('button')].find(b => /join/i.test(b.textContent))
                                ?? document.querySelector('button[type="submit"], form button');
                            let acted = [];
                            if (inp && !inp.value) {
                                inp.value = 'NativePeer';
                                inp.dispatchEvent(new Event('input', {bubbles:true}));
                                acted.push('filled');
                            }
                            if (btn) { btn.click(); acted.push('clicked:' + btn.textContent.trim()); }
                            console.log('[autojoin] ' + location.pathname + ' ' + acted.join(',') + ' inputs=' + document.querySelectorAll('input').length + ' buttons=' + document.querySelectorAll('button').length);
                        })()"#;
                        for _ in 0..30 {
                            let _ = win.eval(js);
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        }
                    });
                }
            }
            Ok(())
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![speech_endpoint])
        .run(tauri::generate_context!())
        .expect("error while running circle");
}
