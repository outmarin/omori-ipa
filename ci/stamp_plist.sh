#!/bin/bash
# Force the essential CFBundle* keys into a built .app Info.plist.
# cordova-ios sometimes leaves them as unresolved $(VAR) or missing, which
# makes `simctl install` fail with "Missing bundle ID" / "no valid CFBundleVersion".
set -e
PLIST="$1"
APPDIR="$(dirname "$PLIST")"
APPNAME="$(basename "$APPDIR" .app)"   # e.g. "OMORI"

pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" 2>/dev/null; }
set_str() {  # key value
    pb "Set :$1 $2" || pb "Add :$1 string $2"
}

set_str CFBundleIdentifier          com.poring.omori.ru
set_str CFBundleExecutable          "$APPNAME"
set_str CFBundleName                "$APPNAME"
set_str CFBundleDisplayName         OMORI
set_str CFBundleVersion             1.0.8
set_str CFBundleShortVersionString  1.0.8
set_str CFBundlePackageType         APPL
set_str CFBundleInfoDictionaryVersion 6.0
set_str MinimumOSVersion            13.0

# LSRequiresIPhoneOS (bool)
pb "Set :LSRequiresIPhoneOS true" || pb "Add :LSRequiresIPhoneOS bool true"

# UIDeviceFamily [1,2] (iPhone, iPad)
pb "Print :UIDeviceFamily" >/dev/null 2>&1 || {
    pb "Add :UIDeviceFamily array"
    pb "Add :UIDeviceFamily:0 integer 1"
    pb "Add :UIDeviceFamily:1 integer 2"
}

echo "[stamp_plist] stamped $PLIST (exec=$APPNAME)"
