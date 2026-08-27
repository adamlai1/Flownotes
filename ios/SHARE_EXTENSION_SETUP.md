# Share Extension setup (v1.2)

One-time Xcode work to add the "Share to Nubble" extension. All source files
already exist in the repo — this checklist only creates the target and wires
capabilities, so `project.pbxproj` is only ever touched by Xcode itself.

**Sources:**
- App-target side (already in place, nothing to add in Xcode):
  `SharedImportPlugin` and `MainViewController` live inside
  `App/App/SceneDelegate.swift`, and Main.storyboard already points at
  MainViewController — so main compiles today, before any of these steps.
- Extension files (canonical copies to paste in): `share-extension-src/`
- Web side: already wired (`src/lib/shareImport.js` + Import screen prop)

**Prereqs:** Mac with Xcode 15+, signed into the team (749R476GNN), a device
on iOS 15+. Run `npm run build && npx cap sync ios` first.

---

## Part A — App target (~5 min)

1. Open `ios/App/App.xcodeproj` in Xcode.

2. **App Groups capability.** Project → target **App** → *Signing &
   Capabilities* → *+ Capability* → **App Groups** → press **+** in the App
   Groups box → enter exactly:

   ```
   group.com.adamlai.flownotes
   ```

   Leave it checked. Xcode writes `App/App.entitlements` — a reference copy
   with the expected content is already at that path; after this step confirm
   it still contains just the one group.

3. **Build & run the App scheme on your device once.** The app must behave
   exactly as before (the plugin is registered but idle). This build also
   registers the App Group with the developer portal via automatic signing.

## Part B — Share Extension target (~10 min)

4. *File → New → Target…* → **iOS → Share Extension** → Next.
   - Product Name: `ShareExtension` (exact — the bundle ID becomes
     `com.adamlai.flownotes.ShareExtension`)
   - Team: same team; Language: **Swift**; Embed in Application: **App**
   - Finish. When Xcode asks *"Activate ShareExtension scheme?"* → **Cancel**
     (keep building the App scheme; the extension is embedded).

5. **Replace the template's files** (the template ships a compose-style UI we
   don't want):
   - Open the new group's `ShareViewController.swift` and replace its
     **entire contents** with `share-extension-src/ShareViewController.swift`.
   - Delete the template's `MainInterface.storyboard` (*Move to Trash*), if
     one was generated.
   - Open the ShareExtension target's `Info.plist` and replace its contents
     with `share-extension-src/Info.plist`. If your Xcode version generated
     the target *without* an Info.plist file, instead add the provided one to
     the target and set the target's `INFOPLIST_FILE` build setting to it.
     Either way, the things that matter:
     - `CFBundleDisplayName` = `Nubble` (what the share sheet shows)
     - `NSExtensionPrincipalClass` = `$(PRODUCT_MODULE_NAME).ShareViewController`
     - **no** `NSExtensionMainStoryboard` key anywhere
     - the activation rule dict: `NSExtensionActivationSupportsText` = YES,
       `NSExtensionActivationSupportsWebURLWithMaxCount` = 1

6. **App Groups on the extension.** Target **ShareExtension** → *Signing &
   Capabilities* → *+ Capability* → **App Groups** → tick the **same**
   `group.com.adamlai.flownotes`. (Reference entitlements:
   `share-extension-src/ShareExtension.entitlements`.)

7. **Deployment target.** Set ShareExtension's *iOS Deployment Target* (Build
   Settings) to the same value as the App target, or Xcode will warn about
   embedding a newer extension.

8. Build & run the **App** scheme on the device.

## Part C — Verify on device

- **Apple Notes:** open a long note → Share → **Nubble** appears → tapping it
  opens the app on Import, preview stage, full text present. Split pills
  ("Blank Lines", "Custom Separator") and destination pickers work exactly as
  they do for pasted text.
- **Safari:** share a page → arrives as the page URL in the import preview.
- **Messages:** long-press a message → share → same flow.
- **App already open:** open Nubble, background it, share from Notes → Nubble
  foregrounds straight onto Import with the text.
- **Force-quit:** force-quit Nubble, share from Notes → cold start lands on
  Import with the text (delivered via `getLaunchUrl`).
- **Stale payload is cleared, not imported:** share from Notes; when Import
  opens, back out without importing; force-quit; relaunch from the home-screen
  icon → Import must NOT reappear with the old text. (Any payload the app
  wasn't opened *by* is discarded on the next launch, and payloads older than
  5 minutes are discarded even on the trigger path.)
- **Very long note** (several thousand words): scroll the preview to the end —
  nothing truncated. The text travels via App Group storage, never the URL, so
  there is no length ceiling in play.
- **Non-text share** (a photo in Photos): Nubble does not appear in the share
  sheet at all — that's the activation rule declining it.

## Troubleshooting

- **Nubble missing from the share sheet:** activation rule got lost (step 5),
  or iOS is caching the sheet — delete the app, reboot, reinstall.
- **App opens but Import is empty:** App Group missing on one of the two
  targets, or the group ID doesn't match `group.com.adamlai.flownotes`
  exactly (it's hard-coded in `ShareViewController.swift` and in
  `SharedImportPlugin` inside `App/App/SceneDelegate.swift`).
- **Signing error mentioning application-groups:** both targets must use the
  same team with automatic signing, and the account must be a paid developer
  account.
- **Extension runs but the app never opens:** some host apps block the
  responder-chain `openURL:`. The payload is then discarded on the next
  manual launch by design — text is never imported without the user having
  been brought to the Import screen for it.
