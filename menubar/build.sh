#!/bin/sh
# Builds the menu bar companion into dist/Anthive.app with the Swift that ships in Xcode's Command Line Tools.
# No Xcode project, no dependencies: one Swift file, an Info.plist, an ad-hoc signature.
set -e
cd "$(dirname "$0")/.."
out=dist/Anthive.app
rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
cp menubar/Info.plist "$out/Contents/Info.plist"
swiftc -O -swift-version 5 -framework Cocoa -framework SwiftUI -framework UserNotifications -framework ServiceManagement \
  -o "$out/Contents/MacOS/Anthive" menubar/Anthive.swift
codesign --force --sign - "$out" 2>/dev/null || true
echo "built $out"
echo "run it:   open $out"
echo "it looks for anthive in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin — or: defaults write dev.anthive.menubar anthive /path/to/anthive"
