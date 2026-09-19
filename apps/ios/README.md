# ReLoop iOS App

SwiftUI iPhone app that streams the Meta Ray-Ban glasses camera to the ReLoop
backend. The backend identifies resellable objects in each frame and draws an
estimated price on them in the live view at `/capture`.

This document is the whole install path, including the things that actually
cost us hours. Read the **Troubleshooting** section before you assume something
is broken — most of what goes wrong here looks like something else.

---

## The naming split — do not "fix" it

The product is **ReLoop**. The Xcode project, target and scheme are still
**BloomKnights**, the bundle id is still `com.bloomknights.app`, and the URL
scheme is still `bloomknights://`.

This is deliberate. The bundle id and URL scheme are what the app's
registration in the Meta Wearables Developer Center is tied to. Renaming them
breaks glasses registration until someone re-registers the app, which is not
something you want to discover during a demo.

Only `CFBundleDisplayName` is `ReLoop`, which is what shows under the icon on
the home screen. If you see the inconsistency and feel the urge to tidy it up:
don't. There is a comment block at the top of `project.yml` saying the same.

---

## 1. Generate the Xcode project

The `.xcodeproj` is generated from `project.yml` by XcodeGen. **Never hand-edit
the `.pbxproj`** — your changes are erased the next time anyone regenerates.

```bash
brew install xcodegen
cd apps/ios/BloomKnights
xcodegen
```

This pulls in the `meta-wearables-dat-ios` package, the `bloomknights://` URL
scheme, background modes and the MWDAT config.

## 2. Signing

`project.yml` sets `DEVELOPMENT_TEAM: A39763Q74K`. If you are on a different
Apple ID, that team id is not yours and the build will fail to sign.

Either edit `DEVELOPMENT_TEAM` in `project.yml` (then re-run `xcodegen`), or
open the project in Xcode and set **target BloomKnights → Signing &
Capabilities → Automatically manage signing** with your own team. A free
personal Apple ID works; Xcode may offer to change the bundle id suffix if
`com.bloomknights.app` is already taken by someone else's build — but see the
naming note above before you accept, because changing it costs you the glasses
registration.

Always pass `-allowProvisioningUpdates` on the command line so Xcode can create
the profile for you:

```bash
xcodebuild -project BloomKnights.xcodeproj -scheme BloomKnights \
  -destination 'generic/platform=iOS' -configuration Debug \
  -allowProvisioningUpdates build
```

## 3. Make the phone visible to Xcode

This blocked us for hours. A phone that is *network*-paired is **not** enough —
it will sit there looking connected and refuse to be a build destination.

Check, rather than guess:

```bash
xcrun xctrace list devices     # yours must NOT be under "== Devices Offline =="
xcrun devicectl list devices   # State must be "available (paired)", not "unavailable"
```

If it is offline or unavailable: **plug it in over USB, unlock it, and tap
Trust** (then enter your passcode). Use a data cable — a charge-only cable
powers the phone without ever enumerating it, which looks identical from the
outside. Keep the phone unlocked and awake for the next few minutes; it can
drop back to `unavailable` if it locks mid-build.

Developer Mode must also be on: **Settings → Privacy & Security → Developer
Mode → toggle on → Restart**, then confirm after reboot. The menu item only
appears *after* a development app or device-support image has touched the
phone. Check the current state with:

```bash
xcrun devicectl device info details --device <UDID> | grep developerModeStatus
```

## 4. Install and launch

```bash
DEV=<device-id from devicectl list devices>
xcrun devicectl device install app --device $DEV \
  ~/Library/Developer/Xcode/DerivedData/BloomKnights-*/Build/Products/Debug-iphoneos/BloomKnights.app
xcrun devicectl device process launch --device $DEV com.bloomknights.app
```

If the launch is refused with *"invalid code signature, inadequate entitlements
or its profile has not been explicitly trusted by the user"*, the app is
installed fine and you just have not trusted the certificate yet: **iOS
Settings → General → VPN & Device Management → your developer cert → Trust**.

## 5. Enable Developer Mode in the Meta AI app

Separate from iOS Developer Mode, and also required.

1. Meta AI app → **Settings → App Info**
2. Tap the **app version number five times**
3. A **Developer Mode** toggle appears — turn it on

Your app then appears under **Meta AI settings → App connections → Developer
mode apps**, and can register against the glasses without going through
publishing review.

Two account traps:

- The account signed in **on the glasses** must be the same account the app
  registration lives under. A mismatch fails in a way that does not say so.
- Log out of `developers.meta.com` first. `wearables.developer.meta.com` is a
  different domain and the two sessions conflict.

## 6. Point the app at the backend — read this one

**`ApiClient.swift` used to default to `http://localhost:3000`.** On a real
iPhone, `localhost` is the phone itself, so every frame was POSTed into the
void.

The symptom is the part worth memorising, because it does not look like a
networking problem: **the glasses stream appears fine in the app, counters may
even tick up, and the server has received nothing.** Confirm with:

```bash
curl http://localhost:3000/api/live-frame
# {"error": "no live camera frame received yet"}  <- app is talking to itself
```

The fix is to set the server URL in the app's **Settings** screen to an address
the phone can actually reach. Prefer the Mac's **Tailscale** address over a LAN
IP — it survives a wifi/cell switch, which matters on venue wifi:

```
http://100.104.109.111:3000
```

Find yours with `tailscale ip -4`. A LAN IP (`ipconfig getifaddr en0`) also
works while both devices are on the same network and the firewall allows
inbound 3000.

> **A saved value beats the default.** The URL is stored in `UserDefaults`, and
> that survives reinstalling the app. If you ever saved `localhost`, a new
> build will *not* fix it — you have to change it in Settings.

The app ships an App Transport Security exception, so plain `http://` to an IP
works from the native app.

## 7. The browser phone page needs HTTPS, the app does not

`tailscale serve` is set up on the Mac, so the web pages are also available at:

- `https://dantes-laptop.tailb2bea0.ts.net/capture`
- `https://dantes-laptop.tailb2bea0.ts.net/phone`

The browser-based phone-camera page (`/phone`) **requires HTTPS**, because
`getUserMedia` only runs in a secure context. Over plain `http://` to an IP the
browser silently blocks the camera and the page just says "Camera unavailable".
Use the `ts.net` URL for `/phone`.

The **native app has no such restriction** — it talks plain `http://` to the
Mac's IP quite happily. Don't burn time making the app use HTTPS; it is only
the browser page that cares.

---

## Troubleshooting

### `value of type 'DeviceSession' has no member 'addStream'`

You are on a stale checkout. `project.yml` pins the Meta Wearables DAT package
at `from: 0.8.0`, which resolves to **0.9.0**, and 0.9.0 **removed**
`DeviceSession.addStream(config:)`. The current code uses
`session.addCamera(config:)` → `Camera`, and streams from `camera.stream`.

Pull `main` and re-run `xcodegen`. The error is confusing because it reads like
an SDK version that is too *new*, when the problem is code that is too old.

### "Session ended by device"

Known Meta SDK quirk. Put the glasses in the case, close the lid for 30
seconds, reopen. Also note the glasses sleep when folded — they need to be on
your face.

### Running out of disk

Xcode will happily fill the disk, and this machine has hit **0 bytes free**,
at which point every shell command fails with `ENOSPC` and nothing makes sense.
Two quick wins:

```bash
# Rebuild cache, always safe to delete
rm -rf ~/Library/Developer/Xcode/DerivedData/*

# Symbols for iOS versions you no longer have on any device — ~5-6GB each.
# Check what is there first; keep the version your phone actually runs.
du -sh ~/Library/Developer/Xcode/iOS\ DeviceSupport/*/
rm -rf ~/Library/Developer/Xcode/iOS\ DeviceSupport/"iPhone15,4 26.5 (23F77)"
```

They re-download if a device ever needs them again.

### A "Downloading 1 item" window claiming hours remaining

After installing to a phone running an iOS version this Mac has not seen, macOS
fetches that version's device-support symbols. That part is normal and the
install cannot complete without it.

What is *not* normal is the progress window wedging: we saw one stuck at ~25%
claiming **363 minutes remaining** while nothing was transferring at all. Check
whether it is real before you wait on it:

```bash
du -sh ~/Library/Developer/Xcode/iOS\ DeviceSupport/*/   # run twice, 10s apart
lsof -nP -p $(pgrep MobileDeviceUpdater) | grep -E 'IPv4|IPv6'  # no sockets = nothing downloading
```

If the folder is not growing and there are no sockets, it is stuck. Kill it —
it is only the progress UI and cancels nothing:

```bash
kill -9 $(pgrep MobileDeviceUpdater)
```

---

## Running the backend

```bash
npm start
# ReLoop desktop: http://localhost:3000
# ReLoop phone:   http://100.104.109.111:3000/phone
```

Analysis starts **disarmed** after every restart. If the overlay stays blank
and looks broken, that is usually all it is:

```bash
curl -X POST http://localhost:3000/api/analysis/start
```

Then open `http://localhost:3000/capture`, press START in the app with the
glasses on, and prices should appear over the objects in frame.
