#!/usr/bin/env bash
# setup-webkit-webrtc.sh — install a WebRTC-capable WebKitGTK runtime for the
# Linux Tauri shell.
#
# Why: every distro builds WebKitGTK with ENABLE_WEB_RTC=OFF (Fedora included —
# RTCPeerConnection is undefined, the app joins signaling but can never peer).
# manafishrov publishes a CI-built WebKitGTK with WebRTC on; we pin the exact
# tag verified against this app, patch its compiled-in prefix to a user-owned
# path, supply the few libs Fedora lacks, and add the gstnice plugin (the
# nicesink/nicesrc elements webrtcbin dies without).
#
# Skew note: the payload is webkit 2.48.7 while tauri's build links against
# the distro's 2.5x headers — verified working; a distro webkit upgrade could
# re-break it. The durable fix is a self-build with ENABLE_WEB_RTC=ON.
#
# Usage:
#   scripts/setup-webkit-webrtc.sh [--bin /path/to/circle] [--launcher NAME]
#   CIRCLE_BIN env var overrides --bin. Result: a `circle-webrtc` launcher
#   (default ~/bin/circle-webrtc) that runs the app with the runtime.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="ghcr.io/manafishrov/webkitgtk-webrtc:2.48.7-x86_64"
ORIG_PREFIX="/usr/lib/Manafish/webkit"            # compiled into the payload
LINK_PREFIX="/tmp/webkitgtk-webrtc4.1"            # EXACTLY 24 chars — the sed
                                                # substitution must preserve
                                                # binary offsets byte-for-byte
[ ${#ORIG_PREFIX} -eq ${#LINK_PREFIX} ] || { echo "prefix length mismatch"; exit 1; }

PAYLOAD="$HOME/.local/share/circle-webkitgtk"     # durable payload home
DEPS="$PAYLOAD/deps"
GST_DIR="$PAYLOAD/gst-plugins"
BIN="${CIRCLE_BIN:-$PWD/src-tauri/target/release/circle}"
LAUNCHER="$HOME/bin/circle-webrtc"

while [ $# -gt 0 ]; do
	case "$1" in
		--bin) BIN="$2"; shift 2 ;;
		--launcher) LAUNCHER="$2"; shift 2 ;;
		*) echo "unknown arg: $1" >&2; exit 1 ;;
	esac
done

command -v curl >/dev/null || { echo "curl required"; exit 1; }
command -v zstd >/dev/null || { echo "zstd required (dnf install zstd)"; exit 1; }

# ---- 1. fetch the OCI layer --------------------------------------------------
# The artifact is a raw tar.zst blob (not a container image — podman can't
# pull it), so we go through the registry blob API with an anonymous token.
if [ ! -d "$PAYLOAD/lib" ]; then
	echo "==> fetching $IMAGE"
	REPO="manafishrov/webkitgtk-webrtc"; TAG="${IMAGE##*:}"
	TOKEN="$(curl -fsSL "https://ghcr.io/token?scope=repository:${REPO}:pull" \
		| sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
	[ -n "$TOKEN" ] || { echo "no registry token"; exit 1; }
	DIGEST="$(curl -fsSL -H "Authorization: Bearer $TOKEN" \
		-H 'Accept: application/vnd.unknown.artifact.v1+json, application/vnd.oci.image.manifest.v1+json' \
		"https://ghcr.io/v2/${REPO}/manifests/${TAG}" \
		| sed -n 's/.*"digest": *"\(sha256:[a-f0-9]*\)".*/\1/p' | head -1)"
	[ -n "$DIGEST" ] || { echo "no layer digest in manifest"; exit 1; }
	TMP="$(mktemp -d)"
	curl -fsSL -H "Authorization: Bearer $TOKEN" \
		"https://ghcr.io/v2/${REPO}/blobs/${DIGEST}" \
		| zstd -d | tar -C "$TMP" -xf -
	mkdir -p "$PAYLOAD"
	# the tarball carries the full install prefix
	if [ -d "$TMP/usr/lib/Manafish/webkit" ]; then
		cp -a "$TMP/usr/lib/Manafish/webkit/." "$PAYLOAD/"
	else
		SRC="$(dirname "$(find "$TMP" -name WebKitWebProcess | head -1)")"
		cp -a "${SRC%/libexec/*}/." "$PAYLOAD/" 2>/dev/null || cp -a "$TMP/." "$PAYLOAD/"
	fi
	rm -rf "$TMP"
fi

# ---- 2. repoint the compiled-in prefix at a user path ------------------------
# Helpers resolve WebKitWebProcess/NetworkProcess/injected-bundle under the
# prefix baked at compile time. Equal-length substitution keeps ELF offsets
# intact; $LINK_PREFIX is a symlink so /tmp churn can't lose the payload.
echo "==> patching prefix $ORIG_PREFIX -> $LINK_PREFIX"
files="$(grep -rlF "$ORIG_PREFIX" "$PAYLOAD" || true)"
for f in $files; do
	sed -i "s|$ORIG_PREFIX|$LINK_PREFIX|g" "$f"
done
ln -sfn "$PAYLOAD" "$LINK_PREFIX"

# ---- 3. satisfy missing shared libs -----------------------------------------
mkdir -p "$DEPS"
PW_LIBS=""
for d in "$HOME/.local/share/ms-playwright"/webkit-*/minibrowser-wpe/lib \
         "$HOME/.cache/ms-playwright"/webkit-*/minibrowser-wpe/lib; do
	[ -d "$d" ] && PW_LIBS="$d" && break
done
missing() { ldd "$1" 2>/dev/null | awk '/not found/ {print $1}' | sort -u; }
NEED="$(missing "$PAYLOAD/lib/libwebkit2gtk-4.1.so.0" | tr '\n' ' ')"
for so in $NEED; do
	[ -e "$DEPS/$so" ] && continue
	src=""
	# the Playwright minibrowser stash ships the exact Ubuntu-era sonames
	# this payload wants (icu74, libjpeg.so.8, libjxl 0.7, woff2)
	[ -n "$PW_LIBS" ] && src="$(find "$PW_LIBS" -name "$so" -o -name "${so%.*}.*" | head -1)"
	if [ -n "$src" ]; then
		cp -L "$src" "$DEPS/$so"
		echo "    dep $so <- $src"
	else
		echo "    MISSING $so — install a package providing it or drop it in $DEPS"
	fi
done
# transitive deps: ldd on the top-level .so can't recurse into libs that were
# themselves missing at scan time (e.g. icuuc -> icudata) — re-scan what we
# copied until fixpoint
for pass in 1 2 3; do
	again=""
	for lib in "$DEPS"/*.so*; do
		again="$again $(LD_LIBRARY_PATH="$DEPS" missing "$lib" | tr '\n' ' ')"
	done
	again="$(echo "$again" | tr ' ' '\n' | sort -u)"
	[ -z "$again" ] && break
	for so in $again; do
		[ -e "$DEPS/$so" ] && continue
		src=""
		[ -n "$PW_LIBS" ] && src="$(find "$PW_LIBS" -name "$so" -o -name "${so%.*}.*" | head -1)"
		if [ -n "$src" ]; then
			cp -L "$src" "$DEPS/$so"
			echo "    dep $so <- $src (transitive)"
		else
			echo "    MISSING $so — install a package providing it or drop it in $DEPS"
		fi
	done
done

# jxl compat: payload wants .0.7 sonames; newer systems only ship .0.x+
for so in libjxl.so.0.7 libjxl_cms.so.0.7 libjxl_threads.so.0.7; do
	[ -e "$DEPS/$so" ] && continue
	for cand in /usr/lib64/libjxl*.so.* "$DEPS"/libjxl*.so.*; do
		base="$(basename "$cand" 2>/dev/null || true)"
		case "$base" in "$so"|"") continue;; esac
		case "$base" in "${so%.*}".*) ln -sf "$(basename "$cand")" "$DEPS/$so"; break;; esac
	done
done

# sonames Fedora can't supply at the right version may still come from a
# distro package — soname -> rpm name map, extracted without installing
declare -A SONAME_PKG=(
	[libwoff2dec.so.1.0.2]=woff2
	[libwoff2common.so.1.0.2]=woff2
	[libwoff2enc.so.1.0.2]=woff2
)
for so in "${!SONAME_PKG[@]}"; do
	[ -e "$DEPS/$so" ] && continue
	pkg="${SONAME_PKG[$so]}"
	command -v dnf >/dev/null || break
	TMP="$(mktemp -d)"
	( cd "$TMP" && dnf download -q --nogpgcheck --arch x86_64 "$pkg" && \
	  rpm2cpio "$pkg"-*.x86_64.rpm | cpio -idm --quiet && \
	  find . -name "$so" -exec cp -L {} "$DEPS/$so" \; ) \
		&& echo "    dep $so <- rpm:$pkg" \
		|| echo "    MISSING $so — dnf install $pkg or drop it in $DEPS"
	rm -rf "$TMP"
done

# ---- 4. gstnice — webrtcbin dies ("webrtcbin is closed") without it ---------
mkdir -p "$GST_DIR"
if [ ! -e "$GST_DIR/libgstnice.so" ]; then
	if [ -e /usr/lib64/gstreamer-1.0/libgstnice.so ]; then
		cp -L /usr/lib64/gstreamer-1.0/libgstnice.so "$GST_DIR/"
	elif command -v dnf >/dev/null; then
		TMP="$(mktemp -d)"
		( cd "$TMP" && dnf download -q --nogpgcheck --arch x86_64 libnice-gstreamer1 && \
		  rpm2cpio libnice-gstreamer1*.x86_64.rpm | cpio -idm --quiet && \
		  cp ./usr/lib64/gstreamer-1.0/libgstnice.so "$GST_DIR/" ) || \
			echo "    gstnice: dnf extract failed — 'dnf install libnice-gstreamer1' and re-run"
		rm -rf "$TMP"
	else
		echo "    gstnice: no libnice-gstreamer1 — provide libgstnice.so in $GST_DIR"
	fi
fi
[ -e "$GST_DIR/libgstnice.so" ] && echo "    gstnice ok"

# ---- 5. launcher -------------------------------------------------------------
mkdir -p "$(dirname "$LAUNCHER")"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
# circle-webrtc — run circle on the WebRTC-enabled WebKitGTK (setup-webkit-webrtc.sh)
ln -sfn "$PAYLOAD" "$LINK_PREFIX"
export LD_LIBRARY_PATH="$PAYLOAD/lib:$DEPS\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
export GST_PLUGIN_PATH="$GST_DIR"
exec "$BIN" "\$@"
EOF
chmod +x "$LAUNCHER"

echo "==> done"
echo "    launcher: $LAUNCHER  (binary: $BIN)"
echo "    verify:   GST_PLUGIN_PATH=$GST_DIR gst-inspect-1.0 nicesink | head -3"
echo "    then run the app and check typeof RTCPeerConnection === 'function'"
