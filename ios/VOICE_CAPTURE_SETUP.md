# Siri voice capture setup (v1.3)

One-time Xcode work to add "Add a note to Nubble" — an App Intent that Siri
and the Shortcuts app can run **without opening the app**. All source files
already exist in the repo; this checklist adds one of them to the App target
and changes two build settings, so `project.pbxproj` is only ever touched by
Xcode itself.

**This is v1.3. Do not do any of this in the build being submitted now.**
Everything on main today is inert without step 4: the plugin is registered
but its queue is never written, the web consumer finds an empty queue, and
`INAlternativeAppNames` in Info.plist does nothing until an
AppShortcutsProvider is compiled in.

**Sources:**
- App-target side (already in place, nothing to add in Xcode):
  `VoiceCaptureStore` and `VoiceCapturePlugin` live inside
  `App/App/SceneDelegate.swift` next to `SharedImportPlugin`, and
  `MainViewController` already registers the plugin — so main compiles today,
  before any of these steps.
- The intent (the ONE file this checklist adds to the target):
  `voice-capture-src/AddNoteIntent.swift` — `AddNoteIntent` plus
  `NubbleShortcuts`, the App Shortcuts provider that supplies the Siri phrases.
- Info.plist: `INAlternativeAppNames` (already in place). `.applicationName`
  in a phrase matches `CFBundleDisplayName` (now "Nubble") *and* every entry
  here, so this is belt-and-braces: "Add a note to Nubble" keeps working
  even if the display name changes. Its shape is an **array of dicts**, each
  with an `INAlternativeAppName` string:

  ```xml
  <key>INAlternativeAppNames</key>
  <array>
      <dict>
          <key>INAlternativeAppName</key>
          <string>Nubble</string>
      </dict>
  </array>
  ```

  A bare array of strings is valid plist XML — `plutil` passes it — but the
  `AppIntentsSSUTraining` build step rejects the structure with *"Unable to
  parse Info.plist"* and the build fails. Leave the dict form alone.
- Web side: already wired (`src/lib/voiceCapture.js` + the consumer in
  `App.jsx`).

**No new target.** The intent is compiled into the App itself. With
`openAppWhenRun = false`, iOS runs it in the background: if Nubble isn't
running it is launched **without a scene** — no window, no WKWebView, no
React — writes the capture, and suspends. If Nubble is already running, the
intent runs inside that process and the note lands in the web layer at once.
This is why there is no App Intents *extension* target: an extension would
need an iOS 17 floor and would force the intent type into both bundles (the
shortcuts provider must live in the app), for no gain over the in-app run.

> ## ⚠️ `git pull` alone is NEVER enough on the Mac
>
> The web bundle Xcode packages lives in `ios/App/App/public`, which is
> **untracked** — git never touches it. After **every** pull, before building:
>
> ```
> npm run build && npx cap sync ios
> ```
>
> Skip it and Xcode happily ships whatever JavaScript was synced last time,
> while the Swift side is current. That mismatch has now caused **two
> separate multi-hour debugging sessions** (share extension: app opened with
> an empty Import; voice capture: queue filled, nothing ever drained). Both
> times the native side was fine and the fix was this one command. If a
> symptom looks like "native works, web side does nothing", run it before
> reading a single log line.

**Prereqs:** Mac with Xcode 15+, signed into the team (749R476GNN), a device
on **iOS 16+**. Run `npm run build && npx cap sync ios` first (see above).

**Updating an existing install:** unlike the share extension, the intent file
is added to the target *by reference* (step 4, "Copy items if needed"
**unchecked**), so the repo file IS the compiled file — edit it in place and
rebuild; no re-pasting. Web-side changes still need
`npm run build && npx cap sync ios` or the native bundle goes stale.

---

## Recorded decision: minimum iOS goes from 15 to 16

App Intents require iOS 16. Raising the App target's deployment target to
16.0 **drops iOS 15 devices** (iPhone 6s / 7 / SE 1st gen and earlier). This
was decided deliberately for v1.3, not inherited as a side effect of the
feature: the alternative — keeping 15.0 and annotating every intent type with
`@available(iOS 16, *)` — keeps a floor nobody is on at the cost of a build
that must compile two ways. Existing iOS 15 installs keep working; they just
stop receiving updates from 1.3 on.

---

## Part A — Build settings (~5 min)

1. Open `ios/App/App.xcodeproj` in Xcode.

2. **Deployment target.** Project → target **App** → *General* → *Minimum
   Deployments* → **iOS 16.0**. Then target **ShareExtension** → the same
   **16.0** (an extension whose target is below its host's builds, but keep
   them equal — the share doc's step 7 rule).

   Do **not** change `CapApp-SPM/Package.swift` (`.iOS(.v15)`): a package
   floor below the app's is fine, and touching it re-resolves the package.

3. **Version.** Target **App** → *General* → *Version* → **1.3** (bump
   *Build* as usual). The share extension inherits `MARKETING_VERSION`, so it
   follows automatically — confirm on its General tab.

   **App Groups** needs nothing: the App target already has
   `group.com.adamlai.flownotes` from the share extension setup (confirm it is
   still the only group under *Signing & Capabilities*). The intent runs in
   the app process, so that one entitlement covers it. No Siri capability is
   required for App Intents / App Shortcuts.

## Part B — Add the intent (~5 min)

4. **Add the file to the App target.** In the navigator select the **App**
   group (the folder holding `SceneDelegate.swift`) → *File → Add Files to
   "App"…* → pick `ios/voice-capture-src/AddNoteIntent.swift`.
   - **Copy items if needed: UNCHECKED** (add by reference — the repo file is
     the one compiled).
   - *Added folders*: irrelevant for a single file.
   - *Add to targets*: **App** only. Not ShareExtension.

   Xcode writes the file reference and build-phase entries into
   `project.pbxproj`. The file shows in the navigator with a slightly
   different path (`../../voice-capture-src/…`) — that is expected.

5. **Build the App scheme.** Expected: no errors, and a build log line from
   `appintentsmetadataprocessor` (Xcode extracts the intent + shortcut
   metadata into `Metadata.appintents` inside the bundle). If that line is
   missing the file didn't make it into *Compile Sources* — check target
   membership in the File Inspector.

   If the build says `'AppIntent' is only available in iOS 16.0 or newer`,
   step 2 didn't take on the App target.

   If it fails at **`AppIntentsSSUTraining`** with *"Unable to parse
   Info.plist"*, `INAlternativeAppNames` has lost its dict shape (see
   *Sources* above) — the plist is well-formed XML, so `plutil` won't catch
   it; only the App Intents processor does.

6. **Run on the device once.** The app must behave exactly as before. This
   install is what registers the App Shortcut with the system — from here on
   the phrase works, including after a delete-and-reinstall, with no launch.

## Part C — Verify on device

Filter **Console.app** on subsystem `com.adamlai.flownotes.VoiceCapture`
(process: `App`). Only lengths and ids are logged, never the spoken text.
Two categories: `intent` (the intent ran) and `store` (the queue).

0. **Queue write verification — do this first.** With Console streaming,
   **force-quit Nubble**, then say to Siri: *"Add a note to Nubble"*. Siri
   asks *"What's the note?"* — answer with a sentence. Expected within a
   second, from a process named `App` that has **no UI on screen**:

   ```
   capture <id> written: <N> chars, queue depth 1
   intent stored capture <id> (<N> chars)
   ```

   and Siri says **"Added to Nubble"**. Nubble must **not** come to the
   foreground. If the lines are missing but Siri said "Added", the intent ran
   in a process Console isn't showing — remove the process filter and keep
   just the subsystem. If instead you see `App Group unavailable` or
   `FAILED readback`, **stop here**: the App Group capability is missing on
   the App target (Part A) and nothing below can pass.

   Now open Nubble from the icon. Expected: the toast **"Added a note from
   Siri"**, the note at the root of the current project (canvas, no bubble),
   and in Console:

   ```
   list: 1 queued capture(s)
   ack: removed 1 of 1
   ```

   **The ack line is the tell.** `list` without `ack` means the web side
   received the captures but did not confirm persisting them — the queue is
   intact, and that is a bug in `App.jsx`'s consumer, not in the hand-off.

- **Several notes before opening.** Force-quit Nubble. Add three notes via
  Siri in a row (queue depth 1, 2, 3 in Console). Open Nubble → toast "Added
  3 notes from Siri", three root-level notes, in the order spoken, each
  dated **when it was spoken**, not when the app opened. Console:
  `list: 3 queued capture(s)` … `ack: removed 3 of 3`.
- **Nubble open in the foreground.** Leave it on the canvas, invoke Siri
  (side button), add a note. The note appears **immediately** — no
  background/foreground cycle — with the toast. Console shows the `store`
  write, then `list`/`ack` within a second.
- **Nubble in the background.** Background it, add a note via Siri, return
  via the app switcher → the note is there on return.
- **Shortcuts app.** Open Shortcuts → search **"Add a Note"** → Nubble's
  action is listed with a *Note* text field. Build a shortcut, run it: same
  result, no app launch. Also check the Shortcuts *App Shortcuts* tile for
  Nubble lists all five phrases.
- **Empty note.** *"Add a note to Nubble"* → say nothing / cancel → nothing is
  queued (Siri re-asks or gives up; no `written` line).
- **Fresh install (works before first launch).** Delete Nubble. Reinstall
  from Xcode but do **not** open it. *"Add a note to Nubble"* → "Added to
  Nubble", and Console shows the write. Then open Nubble for the first time:
  the note appears **only after** you get past the login screen — as a guest,
  immediately on the canvas; signed in, see the next test.
- **The guard: captured before sign-in, then sign in to an account with
  cloud data.** This is the one that matters. Sign out (so the login screen
  shows on next launch), force-quit, add a note via Siri. Open Nubble — on
  the **login screen** nothing happens and Console shows **no `list` line**
  (the queue is not touched while the merge question could still be asked).
  Sign in to an account that already has notes. Wait for the sync to finish
  (status pill goes to synced). **Then** the toast appears and the note is at
  the root of the project that was restored — Console `list`/`ack` only now.
  Repeat once choosing **"Use cloud"** in the merge dialog if one appears:
  the spoken note must still land afterwards, never be discarded with the
  local data. A spoken note that vanishes on this path is a real bug in the
  readiness gate (`voiceReady` in `App.jsx`), not in the hand-off.
- **Offline at launch, signed in.** Airplane mode on, force-quit, add a note
  via Siri, open Nubble. The note does **not** appear yet (Console: no
  `list`) — the initial sync couldn't run, so the merge question is still
  open. Airplane mode off, force-quit, relaunch → sync runs → the note lands.
  This is loss-free by design; captures wait as long as they have to.
- **Sync.** After any of the above while signed in, open Nubble on another
  device (or the web): the spoken note is there, at the root, with the
  spoken-at timestamp.
- **Nothing expires.** Add a note via Siri, don't open Nubble for a day, open
  it → the note lands. (Contrast the share flow's 10-minute window: a share
  is an abandoned *import*; a spoken note is a *committed* note.)
- **Share extension still works** (Part C of `SHARE_EXTENSION_SETUP.md`,
  the Apple Notes case is enough) — same App Group, different keys, no
  interaction, but the deployment-target change rebuilt it.

## Troubleshooting

- **Siri says "Added" (Console shows `written`, queue depth climbing) but
  opening Nubble does nothing — no toast, no notes:** rule out a stale web
  bundle FIRST, before any log filtering. See the warning at the top: the
  native bundle folder is untracked, so `git pull` leaves the app running
  JavaScript from before the consumer existed. Run
  `npm run build && npx cap sync ios`, rebuild in Xcode, open the app —
  the queue is intact and every waiting capture lands on that open. (This
  exact symptom cost a multi-hour session on 2026-09-03; the write side was
  fine the whole time.)
- **Bundle is current, captures still don't land while signed in:** the
  readiness gate is holding them — by design when the initial sync didn't
  settle (offline at launch, or a sync error). Force-quit and relaunch
  online; a successful sync releases the queue. If the status pill shows
  synced and they still don't land, that's a bug in `voiceReady` in
  `App.jsx`; the queue is intact.

- **Siri says "I don't see an app for that" / phrase not recognised:** the
  App Shortcut isn't registered. Step 6 hasn't been run since step 4, or the
  metadata processor didn't run (step 5). Also check `CFBundleDisplayName`
  is still "Nubble" or `INAlternativeAppNames` is still in
  `App/App/Info.plist` in its array-of-dicts shape — the phrase matches
  either. Rebooting the device after a reinstall clears Siri's phrase cache.
- **Build fails at `AppIntentsSSUTraining`, "Unable to parse Info.plist":**
  `INAlternativeAppNames` is an array of strings instead of an array of
  `{ INAlternativeAppName: … }` dicts. Restore the form shown under
  *Sources*. `plutil -lint` passes either way, so don't use it as the check.
- **Siri opens Nubble instead of running in the background:** someone set
  `openAppWhenRun` to `true`, or an older build is installed. Also happens if
  the intent throws before its result — check Console for an `intent failed`
  line.
- **Siri says "Nubble couldn't save the note":** that is
  `VoiceCaptureError.appGroupUnavailable` spoken aloud — App Group missing
  on the App target, or the group ID doesn't match
  `group.com.adamlai.flownotes` exactly (hard-coded in `VoiceCaptureStore`).
- **Notes land only when Nubble is force-quit and relaunched, never while it
  is open:** `VoiceCapturePlugin` isn't receiving the store notification —
  `MainViewController` must register it (`registerPluginInstance`); check
  the storyboard still points at `MainViewController`.
- **Console shows `list` but never `ack`, note not visible:** the web
  consumer returned no ids. Look for `[voice] drain failed` in Safari's Web
  Inspector for the device. The queue is intact; fix and relaunch.
- **Console shows `skipping unreadable capture file`:** a queue file that
  isn't valid JSON. It is never deleted automatically. Inspect it with Xcode
  → Window → Devices → App → Download Container → `AppGroup/VoiceCaptures/`.
- **Compile error about `AppIntents` availability:** Part A step 2 was not
  applied to the App target (the file is annotated `@available(iOS 16.0, *)`
  regardless, so this means something else in the target is at the old
  floor — check the *App* target, not the project).
- **Xcode warns the ShareExtension deployment target differs from the App's:**
  step 2 was done on one target only.
