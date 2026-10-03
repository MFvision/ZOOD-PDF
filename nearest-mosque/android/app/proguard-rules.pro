# kotlinx.serialization: keep generated serializers for pack models.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class sa.zood.nearmosque.core.** {
    *** Companion;
}
-keepclasseswithmembers class sa.zood.nearmosque.core.** {
    kotlinx.serialization.KSerializer serializer(...);
}
