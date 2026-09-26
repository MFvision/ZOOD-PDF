/* SwiftPM needs one source file per C target. The warraq_* symbols come from the warraq-core
 * static library: on Linux from $WARRAQ_LIB_DIR (scripts/ios/test-linux.sh), on iOS from
 * Frameworks/WarraqCore.xcframework linked by the app target (scripts/ios/build-core.sh).
 * include/warraq.h is a copy of packages/core/crates/warraq-core/include/warraq.h; the
 * HeaderSyncTests test fails when the two drift apart. */
#include "warraq.h"
