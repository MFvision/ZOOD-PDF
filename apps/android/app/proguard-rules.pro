# The page calls these by name through addJavascriptInterface.
-keepclassmembers class sa.zood.pdf.Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
