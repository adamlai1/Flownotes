# Share Extension setup (v1.3)

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

**Updating an existing install:** the Xcode target's `ShareViewController.swift`
is a *pasted copy* of `share-extension-src/ShareViewController.swift`, so any
change to the canonical file must be re-pasted over the target's copy (Part B
step 5) and rebuilt — it does not sync. (v1.3 changed it: the extension now
attempts to launch the app, with save-and-switch as the fallback. No build
settings change — see the note at the end of Part B.) Web-side
changes need `npm run build && npx cap sync ios` or the native bundle goes
stale.

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

> **Why `launchHostApp` goes through an ObjC selector/IMP instead of calling
> `UIApplication.open(...)` directly:** the direct call only compiles with
> *Require Only App-Extension-Safe API* (`APPLICATION_EXTENSION_API_ONLY`)
> set to No, and that setting **cannot** be turned off for this target — the
> linker enforces it across the extension and every library it links, failing
> with "Application extensions and any libraries they link to must be built
> with the APPLICATION_EXTENSION_API_ONLY build setting set to YES". LocalSend
> ships the direct call only because their code lives in a pod built as a
> separate unit with the flag off, which this project can't reproduce without
> restructuring into a separate library. The selector invocation is the same
> non-deprecated API stated in the only form that builds here — necessity, not
> evasion. Leave the build setting at its default (**Yes**) on both targets;
> the pasted file compiles under it as-is.

## Part C — Verify on device

The flow is **save, then try to launch**: the extension writes the payload to
the App Group, then attempts to foreground Nubble via an *unsupported*
responder-chain call (the LocalSend approach — see the comment block in
`share-extension-src/ShareViewController.swift`). There are two valid
outcomes, and telling them apart matters:

- **Launch worked** (expected on current iOS): the share sheet dismisses with
  **no card**, Nubble foregrounds by itself, and Import opens prefilled.
  Console shows `host app launch succeeded`.
- **Launch failed** (the designed degradation — Apple has broken this pattern
  before and may again): the "Saved — open Nubble to import" card shows for
  ~1.5 s and the sheet dismisses; the user foregrounds Nubble themselves (app
  switcher or icon) and lands on Import prefilled. Console shows
  `host app launch failed — falling back to save-and-switch`.

**The card is the tell.** No card + app opens = launch worked. Card = launch
failed; the data still arrived (verify with step 0) and every test below must
still pass via manual switch. A card *followed by* the text being missing when
the app is opened by hand is a real bug — that's the App Group hand-off, not
the launch.

0. **App Group write verification — do this first.** Connect the device, open
   **Console.app** on the Mac, select the device, and set the search filter to
   subsystem `com.adamlai.flownotes.ShareExtension` (or filter on process
   `ShareExtension`). Start streaming, then share a note from Apple Notes.
   Expected within a second of sharing:

   ```
   App Group write verified: <N> chars
   host app launch succeeded        ← or: host app launch failed — falling back to save-and-switch
   ```

   with N matching the note's length. The second line is the authoritative
   launch-worked / launch-failed signal. If instead you see
   `App Group write FAILED readback` or `App Group unavailable`, **stop here**
   — the App Group capability is missing or mismatched on one target (Part A
   step 2 / Part B step 6) and none of the tests below can pass. Only lengths
   are logged, never content.

- **Apple Notes:** open a long note → Share → **Nubble** → the sheet
  dismisses and Nubble foregrounds onto Import by itself (launch worked), OR
  the "Saved — open Nubble to import" card shows and you switch to Nubble
  yourself (fallback). Either way: Import, preview stage, full text present.
  Split pills ("Blank Lines", "Custom Separator") and destination pickers work
  exactly as they do for pasted text.
- **Safari:** share a page → same flow → the page URL is in the import
  preview.
- **Messages:** long-press a message → share → same flow.
- **App already open in the background:** open Nubble, background it, share
  from Notes. Launch worked: Nubble foregrounds itself onto Import (the URL
  open triggers the mailbox check). Fallback: return via the app switcher →
  Import opens with the text (the foreground transition triggers the check).
- **Force-quit:** force-quit Nubble, share from Notes. Launch worked: Nubble
  cold-starts onto Import (launch URL). Fallback: launch Nubble from the
  home-screen icon → cold start lands on Import with the text. In the
  fallback, any launch route works — icon, switcher, notification — no
  special URL involved.
- **Stale payload is cleared, not imported** (only exercisable when the
  launch fails — a successful launch consumes the payload immediately):
  share from Notes, then do NOT open Nubble for over 10 minutes → open it →
  Import must not appear; the payload was discarded as abandoned. Also:
  share, open Nubble, back out of Import without importing, force-quit,
  relaunch → the old text must not resurface (the mailbox read already
  cleared it).
- **Very long note** (several thousand words): scroll the preview to the end —
  nothing truncated. The text travels via App Group storage, so there is no
  length ceiling in play.
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
- **Compile error "'UIApplication' is unavailable in application extensions"
  (or the same for `open(_:options:completionHandler:)`):** someone rewrote
  `launchHostApp` as a direct call. That form cannot build in this target —
  see the note at the end of Part B — and flipping *Require Only
  App-Extension-Safe API* to No only trades it for a link error. Restore the
  canonical selector/IMP version from `share-extension-src/` and leave the
  build setting at Yes.
- **Link error "Application extensions and any libraries they link to must be
  built with the APPLICATION_EXTENSION_API_ONLY build setting set to YES":**
  *Require Only App-Extension-Safe API* was set to No on the ShareExtension
  target. Set it back to **Yes** — the canonical extension source doesn't
  need it off.
- **The app does not open automatically after sharing** (the "Saved" card
  shows instead): the launch workaround failed on this iOS version. That is
  the designed degradation, not a hand-off failure — Apple provides no
  supported way for a share extension to open its containing app; the
  extension uses the unsupported LocalSend-style responder-chain call to
  `open(_:options:completionHandler:)`, which Apple has broken once before
  (iOS 18 kill-switched the deprecated `openURL:` selector) and may break
  again. Console shows `host app launch failed — falling back to
  save-and-switch`. The save-and-switch flow must still work: the card
  confirms the save, and the app collects the payload on its next foreground.
  If the text doesn't show up when you *do* open the app, that's a real bug —
  start with the Part C step 0 readback check.
