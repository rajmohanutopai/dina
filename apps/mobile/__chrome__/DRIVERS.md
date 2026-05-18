# Driver setup — adb, idb, Chrome plugin

Each platform-specific driver follows the same pattern: boot the
simulator/browser, point at the Dina app, hand the scenario to
Claude with the right MCP/plugin attached.

## Web driver — Claude Chrome plugin

The Chrome plugin is part of the `claude-in-chrome` MCP server. It
gives Claude `tabs_create`, `navigate`, `computer { action, tabId }`,
`read_page`, `read_console_messages`, and `screenshot` primitives.

### Setup

1. Install the `claude-in-chrome` browser extension in Chrome
   (one-time, follow Anthropic docs).
2. Open Chrome, sign in to the extension.
3. Run `npm run web:export` from `apps/mobile/` to build the SPA
   into `apps/home-node-lite/web/dist/`.
4. Either:
   - Run `apps/mobile/__chrome__/scripts/web-export.sh` which
     builds + starts a static server on port 18290, OR
   - Once Phase 1 lands: start `brain-server` with
     `DINA_BRAIN_WEB_UI=1` and point Claude at
     `http://127.0.0.1:8200/web/`.
5. Verify the driver is alive: in any Claude conversation with the
   MCP attached, ask "list connected browsers" — should return
   your local Chrome.

### Selector strategy

RNW emits `testID` props as `data-testid` attributes. Selectors in
scenarios use the testID verbatim (e.g.
`[data-testid="chat-input"]`).

### Command examples

```ts
// In a Claude prompt running against the web driver:

await tabs_create_mcp()
await navigate({ url: 'http://127.0.0.1:18290/' })
await computer({ action: 'screenshot' })           // proof of state
await read_page({ filter: 'interactive' })         // find testIDs
await computer({ action: 'left_click', ref: 'ref_7' })
await computer({ action: 'type', text: '/remember Emma loves dinosaurs' })
await computer({ action: 'key', text: 'Enter' })
```

## iOS driver — `idb`

Facebook's `idb` (iOS Debug Bridge) lets us drive the iOS simulator
without Xcode UI. The MCP wrapper `mcp-idb` (when available) gives
Claude the same primitives.

### Setup

1. Install dependencies:
   ```
   brew install facebook/fb/idb-companion
   pip3 install fb-idb
   ```
2. Boot an iOS sim:
   ```
   xcrun simctl list devices | grep Booted
   xcrun simctl boot "iPhone 15 Pro"
   ```
3. Start the companion:
   ```
   idb_companion --boot $(xcrun simctl list devices --json | jq -r '.devices | to_entries[] | .value[] | select(.state == "Booted") | .udid' | head -1)
   ```
4. Install + run the Dina dev-client:
   ```
   cd apps/mobile
   npx expo run:ios
   ```
5. Verify the driver:
   ```
   idb list-targets       # should list your booted sim
   idb describe           # tap+screenshot capability check
   idb screenshot /tmp/ios-smoke.png
   ```

### Selector strategy

RN's `testID` prop maps to iOS accessibility identifier. Use the
testID verbatim:

```
idb ui tap-id chat-input
idb ui type-text 'hello from idb'
idb screenshot /tmp/proof.png
```

### Command examples

```bash
# Replaying a scenario step-by-step:
idb launch com.dinakernel.mobile
idb screenshot results/<scenario>/ios/01_open.png
idb ui tap-id chat-input
idb ui type-text "/remember Emma loves dinosaurs"
idb ui press --key 'enter'
idb screenshot results/<scenario>/ios/02_sent.png
```

## Android driver — `adb`

Android Debug Bridge is in `~/Library/Android/sdk/platform-tools/`
when Android Studio is installed (or `brew install android-platform-tools`).

### Setup

1. Install:
   ```
   brew install --cask android-commandlinetools
   sdkmanager --install "platform-tools" "emulator" "system-images;android-34;google_apis;arm64-v8a"
   avdmanager create avd -n Pixel_API_34 -k "system-images;android-34;google_apis;arm64-v8a"
   ```
2. Boot the emulator:
   ```
   emulator -avd Pixel_API_34 -no-snapshot-load &
   adb wait-for-device
   ```
3. Install + run the Dina dev-client:
   ```
   cd apps/mobile
   npx expo run:android
   ```
4. Verify the driver:
   ```
   adb devices             # should list the emulator
   adb shell echo "ok"     # shell access
   adb exec-out screencap -p > /tmp/android-smoke.png
   ```

### Selector strategy

RN's `testID` prop maps to Android resource-id (via
`accessibilityLabel` and the RN compiler). Use the testID via
uiautomator:

```bash
adb shell uiautomator dump /sdcard/window_dump.xml
adb pull /sdcard/window_dump.xml /tmp/android_tree.xml
# parse XML to find resource-id="chat-input", get bounds, tap center
```

A helper script `scripts/adb-tap-by-testid.sh <testID>` will be
added once we have multi-platform scenarios running.

### Command examples

```bash
adb shell am start -n com.dinakernel.mobile/.MainActivity
adb exec-out screencap -p > results/<scenario>/android/01_open.png
# tap by coordinate from uiautomator dump:
adb shell input tap 540 1200
adb shell input text '/remember Emma loves dinosaurs'
adb shell input keyevent KEYCODE_ENTER
adb exec-out screencap -p > results/<scenario>/android/02_sent.png
```

## Driver doctor

Run `scripts/drivers-doctor.sh` to verify which drivers are ready
on this machine:

```
$ ./scripts/drivers-doctor.sh
web driver:     ✅ react-native-web bundle present at ../home-node-lite/web/dist/
ios driver:     ⚠️  idb_companion not installed (brew install facebook/fb/idb-companion)
android driver: ✅ adb on PATH, 1 device connected (emulator-5554)
chrome plugin:  ✅ extension API reachable
```
