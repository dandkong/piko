# Piko mobile client (Expo / React Native)

This is a parallel client for the existing Piko Bun API. Pi SDK sessions and provider credentials remain on the Piko server; the mobile app does not run a second agent runtime.

## Run

From the repository root:

```sh
bun run dev:api
bun run dev:mobile
```

Open the Expo Go QR code on a device, or press `a` / `i` for an available emulator/simulator. To preview the React Native UI in a browser:

```sh
bun run dev:mobile:web
```

The app defaults to `http://127.0.0.1:8787` on iOS Simulator and Expo Web, and `http://10.0.2.2:8787` on the Android Emulator. A physical device can set `EXPO_PUBLIC_PIKO_API_URL` to its secured Piko API address. Piko currently binds to loopback by default and has no API authentication, so do **not** expose it to a LAN or tunnel until authentication and an appropriately restricted network boundary are in place. CORS for Expo Web is limited to localhost development origins by default; additional trusted browser origins can be set with `PIKO_CORS_ORIGINS`.

Expo SDK 57 is used for this prototype. The `uuid` override pins a patched CommonJS-compatible version for Expo's nested `xcode` build dependency.

## Build bundles

```sh
bun run build:mobile:web
bun run build:mobile:ios
bun run build:mobile:android
```

The iOS and Android commands export JavaScript bundles; producing signed native binaries still requires the respective native build toolchain or EAS Build.
