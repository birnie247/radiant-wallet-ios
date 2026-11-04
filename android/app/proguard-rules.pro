# Radiant Wallet — R8/ProGuard rules (release builds)

# Capacitor's bridge looks plugins up by reflection from the @CapacitorPlugin
# annotation, so R8 must not rename or remove them. Keep our own plugins
# explicitly rather than relying solely on the AAR's consumer rules: if these
# are stripped, biometric unlock and FLAG_SECURE silently stop existing at
# runtime (the JS call rejects with "not implemented").
-keep class org.radiant.wallet.** { *; }

# Any Capacitor plugin and its @PluginMethod entry points.
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
}

# Annotations/attributes needed for that reflective lookup.
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# Keep line numbers so crash reports stay actionable (the app contains no
# secrets in class/method names).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

