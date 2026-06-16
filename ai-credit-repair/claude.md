# AI Credit Repair — project notes

A real, installable **native Android app** (React Native + Expo, TypeScript) that runs
entirely on your phone. You upload screenshots/PDFs of your credit reports; the app uses
Claude vision to extract negative items, applies deterministic FCRA/SOL rules, gives
per-item advice, and generates dispute/validation/goodwill/pay-for-delete letter **drafts**
you review and mail yourself.

> Read this file first when resuming. Update it after every significant change.

## Current state — Stage 1 complete (scaffold + foundations)

Built and type-checking. Not yet exercised on a physical device (that happens on your
machine — see “Build & run” below).

What exists:
- Expo SDK **56** managed app, TypeScript strict, **expo-router** (file-based) navigation.
- Bottom tabs: **Dashboard / Upload / Review / Letters / Settings**.
  - Dashboard, Upload, Review, Letters are placeholders wired into navigation.
  - **Settings is fully functional.**
- **On-device SQLite** (`expo-sqlite`) with a migration runner (`PRAGMA user_version`) and
  the full schema for all stages: `settings, documents, accounts, negative_items, advice,
  letters, deadlines, score_log`.
- **Secure API-key storage** (`expo-secure-store`, Android Keystore). Key is never written
  to SQLite, logs, or exports; only ever sent to api.anthropic.com.
- Settings screen: name/address/city/state(picker)/zip, model selector
  (**Claude Sonnet 4.6** default ↔ **Claude Haiku 4.5**), API-key save/replace/remove with
  masked status, and **Wipe all data**.
- First-run nudges on the Dashboard when the API key or profile is incomplete.
- “Not legal advice” disclaimer banner shown across screens.

## Architecture / layout

```
ai-credit-repair/
  app/                         # expo-router routes
    _layout.tsx                # root: opens+migrates DB, then renders tabs
    (tabs)/
      _layout.tsx              # bottom tab bar
      index.tsx                # Dashboard
      upload.tsx               # placeholder (Stage 2)
      review.tsx               # placeholder (Stage 2)
      letters.tsx              # placeholder (Stage 4)
      settings.tsx             # functional Settings
  src/
    components/                # Disclaimer, StagePlaceholder
    constants/                 # models, US states, theme
    db/                        # schema.ts (DDL + migrations), index.ts (open/migrate/wipe)
    lib/                       # secureStore.ts (API key), settings.ts (key/value profile)
    types/                     # models.ts (domain types incl. NegativeItem schema)
  app.json                     # Expo config + Android perms + config plugins
  eas.json                     # development / preview (APK) / production profiles
  babel.config.js              # babel-preset-expo
```

Design rules:
- **100% on-device.** The only outbound network call (added in Stage 2) is to
  `api.anthropic.com`. No backend, server, or analytics.
- Rules engine (Stage 3) is **deterministic TypeScript**, never the LLM. The LLM only
  personalizes wording for the action the rules already chose.
- Nothing proceeds to advice/letters until each item is **confirmed** on the Review screen.

## Build & run (do this on YOUR machine, not the cloud container)

This repo is developed in a remote Linux container that cannot run `eas build` or install
on your phone. Workflow: pull this branch locally, then:

```bash
cd ai-credit-repair
npm install
npm run typecheck          # tsc --noEmit, should pass clean
```

### Option A — Installable APK via EAS (recommended)
```bash
npm install -g eas-cli      # once
eas login                   # your Expo account
eas build:configure         # writes the EAS projectId into app.json (first time only)
eas build -p android --profile preview
# When it finishes, open the APK link on your phone (or scan the QR) and install.
```

### Option B — Local dev build (expo-dev-client, for fast iteration)
Requires Android SDK + a connected device/emulator (or Android Studio).
```bash
npx expo run:android        # builds a dev client and installs it
npm run start               # then start Metro (expo start --dev-client)
```

### Option C — Quick UI preview in Expo Go (limited)
Some native modules (secure-store, sqlite, notifications) work in Expo Go on SDK 56, but
prefer a dev/preview build for an accurate test:
```bash
npm run start
```

## Known follow-ups / notes
- `expo-image-picker` auto-adds `RECORD_AUDIO` to the Android manifest. We don’t use audio;
  strip it in a later stage via a small config plugin / `expo-build-properties` before
  shipping, for privacy hygiene.
- `app.json > extra.eas.projectId` is empty; `eas build:configure` fills it.
- Network policy in the cloud container blocks `api.expo.dev` (so `expo install` and
  `expo-doctor` version checks fail there) — that’s why deps are pinned by hand from
  `node_modules/expo/bundledNativeModules.json`. This does NOT affect your local machine.

## Next steps — Stage 2 (after your review)
Upload + AI extraction:
- expo-image-picker (multi-select + camera) and expo-document-picker (PDF) into `documents`.
- expo-image-manipulator: downscale long edge ≤ 1568 px; optional SSN/account redaction.
- Direct Anthropic Messages API call (fetch, `x-api-key`, `anthropic-version: 2023-06-01`),
  forced tool/schema output, **Zod** validation + one retry, per-field confidence.
- The **human review** screen (source image beside extracted fields, confirm per item).

## Build order (stop for review after each stage)
1. ✅ Scaffold + navigation + SQLite + secure-store + Settings.
2. ⬜ Upload + AI extraction + human review.
3. ⬜ Rules engine (DOFD/7-year, SOL table, classification) + dedup/stitching.
4. ⬜ Advice layer + expo-print letter templates.
5. ⬜ Deadlines + notifications + dashboard + score chart + export/import + wipe polish.
