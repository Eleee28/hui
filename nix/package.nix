{
  lib,
  buildNpmPackage,
  nodejs_24,
  autoPatchelfHook,
  makeWrapper,
  stdenv,
  git,
  ripgrep,
  fd,
  bash,
  xdg-utils,
  libxcb,
  electron_44,
  makeDesktopItem,
  copyDesktopItems,
  tailscale,
  withDesktop ? false,
  gatewayHost ? "127.0.0.1",
  gatewayPort ? 4173,
  electronPackage ? electron_44,
}:

assert builtins.isBool withDesktop;
assert builtins.isInt gatewayPort && gatewayPort >= 0 && gatewayPort <= 65535;
assert
  builtins.isString gatewayHost
  && gatewayHost != ""
  && gatewayHost != "0.0.0.0"
  && gatewayHost != "::";
buildNpmPackage {
  pname = "hui";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  nodejs = nodejs_24;

  # Keep local credentials, memory, build output and node_modules out of the store.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.server.json
      ../vite.config.ts
      ../index.html
      ../bin
      ../cli
      ../desktop
      ../scripts
      ../server
      ../src
      ../public
      ../themes
      ../skills
    ];
  };

  # PI ships its own shrinkwrap; cache URL metadata as well as tarball integrity.
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-lpWF8FgGQjpWVBceoVpO2MPeQcdjYamcYsln47Paaos=";
  npmFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
  ]
  ++ lib.optionals withDesktop [ copyDesktopItems ];
  buildInputs = [
    stdenv.cc.cc.lib
    libxcb
  ];
  LD_LIBRARY_PATH = lib.makeLibraryPath [ stdenv.cc.cc.lib ];

  # npm prune currently fails on PI's nested shrinkwrap. A fresh production-only
  # install uses the same verified offline cache without retaining build tools.
  dontNpmPrune = true;
  preInstall = ''
    npm ci --omit=dev --ignore-scripts
  '';

  postInstall = ''
    # Electron comes from nixpkgs, never its npm downloader.
    rm -rf "$out/lib/node_modules/hui/node_modules/@electron-internal" \
      "$out/lib/node_modules/hui/node_modules/.bin/install-electron"
    ${lib.optionalString (!withDesktop) ''
      rm -rf "$out/lib/node_modules/hui/node_modules/electron" \
        "$out/lib/node_modules/hui/node_modules/.bin/electron"
    ''}
    ${lib.optionalString withDesktop ''
      install -Dm644 public/pi-logo-3d.png "$out/share/icons/hicolor/512x512/apps/hui.png"
    ''}
    # PI's shrinkwrap retains esbuild binaries for other operating systems.
    # Keep only this platform; Solaris ELF files cannot be patched for Linux.
    for directory in "$out/lib/node_modules/hui/node_modules/@esbuild" \
      "$out/lib/node_modules/hui/node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild"; do
      if [ -d "$directory" ]; then
        find "$directory" -mindepth 1 -maxdepth 1 \
          ! -name linux-${if stdenv.hostPlatform.isx86_64 then "x64" else "arm64"} \
          -exec rm -rf {} +
      fi
    done
    wrapProgram "$out/bin/hui" \
      ${lib.optionalString (!withDesktop) "--run "}${
        lib.optionalString (!withDesktop) (
          lib.escapeShellArg ''case "$1" in desktop|install-app) echo "This Nix package is web-only; select hui-desktop or withDesktop = true." >&2; exit 1;; esac''
        )
      } \
      ${lib.optionalString withDesktop "--set ELECTRON_OVERRIDE_DIST_PATH ${electronPackage}/bin"} \
      --set-default HUI_GATEWAY_HOST ${lib.escapeShellArg gatewayHost} \
      --set-default HUI_GATEWAY_PORT ${toString gatewayPort} \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            nodejs_24
            git
            ripgrep
            fd
            bash
            xdg-utils
          ]
          ++ lib.optionals (gatewayHost == "tailnet") [ tailscale ]
        )
      }
  '';

  desktopItems = lib.optionals withDesktop [
    (makeDesktopItem {
      name = "hui";
      desktopName = "HUI";
      comment = "Coding-agent workspace";
      exec = "hui desktop";
      icon = "hui";
      categories = [ "Development" ];
      terminal = false;
    })
  ];

  passthru = {
    inherit
      withDesktop
      gatewayHost
      gatewayPort
      electronPackage
      ;
  };

  meta = {
    description = "Browser-first control surface and gateway for coding agents";
    homepage = "https://github.com/DaniFdz/hui";
    mainProgram = "hui";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
