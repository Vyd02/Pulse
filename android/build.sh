#!/usr/bin/env bash
# Builds Pulse.apk without Gradle. Needs ANDROID_HOME with platforms;android-34 and build-tools;34.0.0.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/sdk}"; BT="$SDK/build-tools/35.0.0"; JAR="$SDK/platforms/android-34/android.jar"
rm -rf build && mkdir -p build/res build/gen build/classes build/dex
"$BT/aapt2" compile --dir res -o build/res/res.zip
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml -A assets \
  --java build/gen --min-sdk-version 26 --target-sdk-version 34 build/res/res.zip
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$JAR" -classpath "$JAR:$BT/core-lambda-stubs.jar" \
  -d build/classes $(find src build/gen -name '*.java')
"$BT/d8" --min-api 26 --release --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
cp build/base.apk build/unsigned.apk
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk
KS="${PULSE_KEYSTORE:-pulse.keystore}"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias pulse -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass pulsepass -keypass pulsepass -dname "CN=Pulse, O=Vyd02" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-key-alias pulse --ks-pass pass:pulsepass --key-pass pass:pulsepass \
  --out ../Pulse.apk build/aligned.apk
echo "Built $(cd .. && pwd)/Pulse.apk"
