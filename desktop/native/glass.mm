#define NAPI_VERSION 8
#include <node_api.h>
#include <cstring>
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <objc/runtime.h>

// State is associated with NSWindow, but owns no NSWindow/responder. The native
// Electron root remains the window's contentView for its entire lifetime.
@interface PEGlassState : NSObject
@property(nonatomic, strong) NSView *originalRoot;
@property(nonatomic, strong) NSView *glass;
@property(nonatomic, strong) NSView *container;
@property(nonatomic, strong) NSArray<NSView *> *originalSubviews;
@property(nonatomic, strong) NSArray<NSLayoutConstraint *> *originalConstraints;
@property(nonatomic, strong) NSArray<NSValue *> *originalFrames;
@property(nonatomic) NSRect originalBounds;
@property(nonatomic) BOOL responderPreserved;
@end
@implementation PEGlassState
@end
static char kPEGlassState;

static bool Supported() {
  if (@available(macOS 26.0, *)) return NSClassFromString(@"NSGlassEffectView") != Nil;
  return false;
}
static napi_value Result(napi_env env, bool ok, bool supported, bool enabled,
                         const char *reason = nullptr, bool responderPreserved = true) {
  napi_value result, value;
  napi_create_object(env, &result);
  napi_get_boolean(env, ok, &value); napi_set_named_property(env, result, "ok", value);
  napi_get_boolean(env, supported, &value); napi_set_named_property(env, result, "supported", value);
  napi_get_boolean(env, enabled, &value); napi_set_named_property(env, result, "enabled", value);
  napi_get_boolean(env, [NSThread isMainThread], &value); napi_set_named_property(env, result, "mainThread", value);
  napi_get_boolean(env, responderPreserved, &value); napi_set_named_property(env, result, "responderPreserved", value);
  if (reason) { napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "reason", value); }
  return result;
}
// Only the trusted main process supplies a live handle. No JS pointer validation
// can make a random/stale address safe; handles must never be exposed over IPC.
static NSWindow *WindowFromHandle(napi_env env, napi_value handle) {
  bool isBuffer = false;
  if (napi_is_buffer(env, handle, &isBuffer) != napi_ok || !isBuffer) return nil;
  void *bytes = nullptr; size_t length = 0;
  if (napi_get_buffer_info(env, handle, &bytes, &length) != napi_ok || length != sizeof(void *)) return nil;
  void *pointer = nullptr; std::memcpy(&pointer, bytes, sizeof(pointer));
  if (!pointer) return nil;
  NSView *view = (__bridge NSView *)pointer;
  if (![view isKindOfClass:[NSView class]]) return nil;
  NSWindow *window = view.window;
  if (!window || !window.contentView) return nil;
  if (view != window.contentView && ![view isDescendantOf:window.contentView]) return nil;
  return window;
}
static bool Applied(NSWindow *window, PEGlassState *state) {
  if (@available(macOS 26.0, *)) {
    return state && window.contentView == state.originalRoot && state.glass.superview == state.originalRoot &&
      ((NSGlassEffectView *)state.glass).contentView == state.container;
  }
  return false;
}
static bool Restore(NSWindow *window, PEGlassState *state, NSResponder *responder) {
  if (@available(macOS 26.0, *)) {
    NSView *root = state.originalRoot;
    const NSRect rootBounds = root.bounds;
    [NSLayoutConstraint deactivateConstraints:state.originalConstraints];
    for (NSUInteger index = 0; index < state.originalSubviews.count; index++) {
      NSView *child = state.originalSubviews[index];
      // Never reattach a renderer view that Electron independently removed.
      if (child.superview != state.container) continue;
      NSRect frame = child.frame;
      const NSRect originalFrame = state.originalFrames[index].rectValue;
      if (NSEqualRects(originalFrame, state.originalBounds)) frame = rootBounds;
      [child removeFromSuperviewWithoutNeedingDisplay];
      [root addSubview:child positioned:NSWindowBelow relativeTo:state.glass.superview == root ? state.glass : nil];
      child.frame = frame;
    }
    ((NSGlassEffectView *)state.glass).contentView = nil;
    [state.glass removeFromSuperviewWithoutNeedingDisplay];
    [root addConstraints:state.originalConstraints];
    [root layoutSubtreeIfNeeded];
    const bool preserved = !responder || window.firstResponder == responder || [window makeFirstResponder:responder];
    objc_setAssociatedObject(window, &kPEGlassState, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return preserved;
  }
  return false;
}
static napi_value SetGlass(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    if (![NSThread isMainThread]) return Result(env, false, Supported(), false, "main-thread-required");
    size_t argc = 2; napi_value argv[2]; bool enabled = false;
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
        napi_get_value_bool(env, argv[1], &enabled) != napi_ok) return Result(env, false, Supported(), false, "invalid-arguments");
    if (!Supported()) return Result(env, !enabled, false, false, "macos-26-required");
    if (@available(macOS 26.0, *)) {
      NSWindow *window = nil; PEGlassState *state = nil; NSResponder *responder = nil;
      @try {
        window = WindowFromHandle(env, argv[0]);
        if (!window) return Result(env, false, true, false, "invalid-window-handle");
        state = objc_getAssociatedObject(window, &kPEGlassState);
        if (state && !Applied(window, state)) return Result(env, false, true, false, "content-view-changed");
        responder = window.firstResponder;
        if (!enabled) return Result(env, true, true, false, nullptr, !state || Restore(window, state, responder));
        if (state) return Result(env, true, true, true, nullptr, state.responderPreserved);
        NSView *root = window.contentView;
        NSArray<NSView *> *children = [root.subviews copy];
        NSMutableArray<NSLayoutConstraint *> *originalConstraints = [NSMutableArray array];
        // Keep root/child constraints intact. Unknown layout guides or outside
        // views keep the original hierarchy untouched.
        for (NSLayoutConstraint *constraint in root.constraints) {
          if (![children containsObject:constraint.firstItem] && ![children containsObject:constraint.secondItem]) continue;
          const bool firstKnown = constraint.firstItem == root || [children containsObject:constraint.firstItem];
          const bool secondKnown = !constraint.secondItem || constraint.secondItem == root || [children containsObject:constraint.secondItem];
          if (!firstKnown || !secondKnown) return Result(env, false, true, false, "managed-layout-unsupported");
          [originalConstraints addObject:constraint];
        }
        if (!children.count) return Result(env, false, true, false, "renderer-view-unavailable");
        NSGlassEffectView *glass = [[NSClassFromString(@"NSGlassEffectView") alloc] initWithFrame:root.bounds];
        if (!glass) return Result(env, false, true, false, "glass-creation-failed");
        // Clear glass refracts the real content behind the window without a
        // fixed color tint; the renderer supplies separate readable text layers.
        // A wider native curved region exposes background bending at the
        // corners. This changes geometry, not a private refraction parameter.
        glass.style = NSGlassEffectViewStyleClear; glass.tintColor = nil; glass.cornerRadius = 40;
        glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        NSView *container = [[NSView alloc] initWithFrame:root.bounds];
        container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        glass.contentView = container;
        state = [PEGlassState new]; state.originalRoot = root; state.glass = glass;
        state.container = container; state.originalSubviews = children;
        state.originalConstraints = originalConstraints;
        state.originalBounds = root.bounds;
        NSMutableArray<NSValue *> *frames = [NSMutableArray array];
        for (NSView *child in children) [frames addObject:[NSValue valueWithRect:child.frame]];
        state.originalFrames = frames;
        objc_setAssociatedObject(window, &kPEGlassState, state, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        [NSLayoutConstraint deactivateConstraints:originalConstraints];
        [root addSubview:glass];
        for (NSView *child in children) {
          const NSRect frame = child.frame;
          [child removeFromSuperviewWithoutNeedingDisplay];
          [container addSubview:child];
          child.frame = frame; // Keep original coordinates, autoresizing and order.
        }
        // The original root remains a common ancestor, so preserve the exact
        // constraint objects (including framework-defined intrinsic constraints).
        [root addConstraints:originalConstraints];
        [glass layoutSubtreeIfNeeded];
        const bool preserved = !responder || window.firstResponder == responder || [window makeFirstResponder:responder];
        state.responderPreserved = preserved;
        if (!preserved || !Applied(window, state)) {
          Restore(window, state, responder);
          return Result(env, false, true, false, "responder-or-layout-rejected", preserved);
        }
        return Result(env, true, true, true, nullptr, preserved);
      } @catch (NSException *) {
        @try { if (state && window.contentView == state.originalRoot) Restore(window, state, responder); }
        @catch (NSException *) {}
        return Result(env, false, true, false, "native-view-operation-failed");
      }
    }
    return Result(env, false, false, false, "macos-26-required");
  }
}
static napi_value Status(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    if (![NSThread isMainThread]) return Result(env, false, Supported(), false, "main-thread-required");
    size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (!Supported()) return Result(env, true, false, false, "macos-26-required");
    if (!argc) return Result(env, true, true, false);
    @try {
      NSWindow *window = WindowFromHandle(env, argv[0]);
      if (!window) return Result(env, false, true, false, "invalid-window-handle");
      PEGlassState *state = objc_getAssociatedObject(window, &kPEGlassState);
      const bool applied = Applied(window, state);
      napi_value result = Result(env, !state || applied, true, applied, state && !applied ? "content-view-changed" : nullptr, !state || state.responderPreserved);
      if (@available(macOS 26.0, *)) {
        if (applied) {
          napi_value style;
          const char *name = ((NSGlassEffectView *)state.glass).style == NSGlassEffectViewStyleClear ? "clear" : "regular";
          napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &style);
          napi_set_named_property(env, result, "style", style);
          napi_value radius;
          napi_create_double(env, ((NSGlassEffectView *)state.glass).cornerRadius, &radius);
          napi_set_named_property(env, result, "cornerRadius", radius);
        }
      }
      // Geometry and class names support isolated probes; no view text is read.
      napi_value number, names;
      napi_create_double(env, NSHeight(window.frame), &number); napi_set_named_property(env, result, "windowHeight", number);
      napi_create_double(env, NSHeight(window.contentView.frame), &number); napi_set_named_property(env, result, "contentHeight", number);
      napi_create_double(env, state ? NSHeight(state.glass.frame) : 0, &number); napi_set_named_property(env, result, "glassHeight", number);
      napi_create_double(env, state ? NSHeight(state.container.frame) : 0, &number); napi_set_named_property(env, result, "containerHeight", number);
      NSArray<NSView *> *children = state ? state.originalSubviews : window.contentView.subviews;
      napi_create_array_with_length(env, children.count, &names);
      for (NSUInteger index = 0; index < children.count; index++) {
        napi_value name; napi_create_string_utf8(env, NSStringFromClass(children[index].class).UTF8String, NAPI_AUTO_LENGTH, &name);
        napi_set_element(env, names, (uint32_t)index, name);
      }
      napi_set_named_property(env, result, "originalSubviewClasses", names);
      napi_create_array_with_length(env, children.count, &names);
      for (NSUInteger index = 0; index < children.count; index++) {
        napi_value frame; napi_create_string_utf8(env, NSStringFromRect(children[index].frame).UTF8String, NAPI_AUTO_LENGTH, &frame);
        napi_set_element(env, names, (uint32_t)index, frame);
      }
      napi_set_named_property(env, result, "originalSubviewFrames", names);
      return result;
    } @catch (NSException *) { return Result(env, false, true, false, "native-view-operation-failed"); }
  }
}

// Resolve one configured accelerator to one public physical key code. This is
// deliberately not a keyboard event tap, key scanner, text reader or event source.
static NSNumber *ShortcutCode(NSString *key, NSEventModifierFlags *modifiers) {
  static NSDictionary<NSString *, NSNumber *> *codes;
  static NSDictionary<NSString *, NSString *> *shifted;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    codes = @{
      @"A":@(kVK_ANSI_A), @"B":@(kVK_ANSI_B), @"C":@(kVK_ANSI_C), @"D":@(kVK_ANSI_D), @"E":@(kVK_ANSI_E),
      @"F":@(kVK_ANSI_F), @"G":@(kVK_ANSI_G), @"H":@(kVK_ANSI_H), @"I":@(kVK_ANSI_I), @"J":@(kVK_ANSI_J),
      @"K":@(kVK_ANSI_K), @"L":@(kVK_ANSI_L), @"M":@(kVK_ANSI_M), @"N":@(kVK_ANSI_N), @"O":@(kVK_ANSI_O),
      @"P":@(kVK_ANSI_P), @"Q":@(kVK_ANSI_Q), @"R":@(kVK_ANSI_R), @"S":@(kVK_ANSI_S), @"T":@(kVK_ANSI_T),
      @"U":@(kVK_ANSI_U), @"V":@(kVK_ANSI_V), @"W":@(kVK_ANSI_W), @"X":@(kVK_ANSI_X), @"Y":@(kVK_ANSI_Y), @"Z":@(kVK_ANSI_Z),
      @"0":@(kVK_ANSI_0), @"1":@(kVK_ANSI_1), @"2":@(kVK_ANSI_2), @"3":@(kVK_ANSI_3), @"4":@(kVK_ANSI_4),
      @"5":@(kVK_ANSI_5), @"6":@(kVK_ANSI_6), @"7":@(kVK_ANSI_7), @"8":@(kVK_ANSI_8), @"9":@(kVK_ANSI_9),
      @"=":@(kVK_ANSI_Equal), @"-":@(kVK_ANSI_Minus), @"[":@(kVK_ANSI_LeftBracket), @"]":@(kVK_ANSI_RightBracket),
      @";":@(kVK_ANSI_Semicolon), @"'":@(kVK_ANSI_Quote), @"\\":@(kVK_ANSI_Backslash), @",":@(kVK_ANSI_Comma),
      @".":@(kVK_ANSI_Period), @"/":@(kVK_ANSI_Slash), @"`":@(kVK_ANSI_Grave),
      @"SPACE":@(kVK_Space), @"ENTER":@(kVK_Return), @"RETURN":@(kVK_Return), @"TAB":@(kVK_Tab),
      @"ESCAPE":@(kVK_Escape), @"ESC":@(kVK_Escape), @"BACKSPACE":@(kVK_Delete), @"DELETE":@(kVK_ForwardDelete),
      @"HOME":@(kVK_Home), @"END":@(kVK_End), @"PAGEUP":@(kVK_PageUp), @"PAGEDOWN":@(kVK_PageDown),
      @"LEFT":@(kVK_LeftArrow), @"RIGHT":@(kVK_RightArrow), @"UP":@(kVK_UpArrow), @"DOWN":@(kVK_DownArrow)
    };
    shifted = @{ @"PLUS":@"=", @"!":@"1", @"@":@"2", @"#":@"3", @"$":@"4", @"%":@"5", @"^":@"6",
      @"&":@"7", @"*":@"8", @"(":@"9", @")":@"0", @"_":@"-", @"{":@"[", @"}":@"]", @":":@";",
      @"\"":@"'", @"|":@"\\", @"<":@",", @">":@".", @"?":@"/", @"~":@"`" };
  });
  if (shifted[key]) { *modifiers |= NSEventModifierFlagShift; return codes[shifted[key]]; }
  if (codes[key]) return codes[key];
  const CGKeyCode functions[] = { kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
    kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20 };
  if ([key hasPrefix:@"F"] && key.length <= 3) {
    const NSInteger index = [[key substringFromIndex:1] integerValue];
    if (index >= 1 && index <= 20 && [key isEqualToString:[NSString stringWithFormat:@"F%ld", (long)index]]) return @(functions[index - 1]);
  }
  // Public Carbon headers define no F21–F24 physical key codes. Do not guess.
  return nil;
}
static napi_value ShortcutKeyDown(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    napi_value unknown; napi_get_null(env, &unknown);
    if (![NSThread isMainThread]) return unknown;
    size_t argc = 1, length = 0; napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
        napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok || !length || length > 160) return unknown;
    char text[161];
    if (napi_get_value_string_utf8(env, argv[0], text, sizeof(text), &length) != napi_ok) return unknown;
    NSString *accelerator = [[NSString alloc] initWithBytes:text length:length encoding:NSUTF8StringEncoding];
    if (!accelerator) return unknown;
    NSEventModifierFlags required = 0;
    NSString *key = nil;
    for (NSString *part in [accelerator componentsSeparatedByString:@"+"]) {
      NSString *token = [[part stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] uppercaseString];
      if ([token isEqualToString:@"CONTROL"] || [token isEqualToString:@"CTRL"]) required |= NSEventModifierFlagControl;
      else if ([token isEqualToString:@"COMMAND"] || [token isEqualToString:@"CMD"] || [token isEqualToString:@"COMMANDORCONTROL"] || [token isEqualToString:@"CMDORCTRL"] || [token isEqualToString:@"SUPER"] || [token isEqualToString:@"META"]) required |= NSEventModifierFlagCommand;
      else if ([token isEqualToString:@"OPTION"] || [token isEqualToString:@"ALT"]) required |= NSEventModifierFlagOption;
      else if ([token isEqualToString:@"SHIFT"]) required |= NSEventModifierFlagShift;
      else { if (key || !token.length) return unknown; key = token; }
    }
    if (!key || !required) return unknown;
    NSNumber *code = ShortcutCode(key, &required);
    if (!code) return unknown;
    const bool pressed = CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, (CGKeyCode)code.unsignedShortValue);
    const bool modifiersMatch = ([NSEvent modifierFlags] & required) == required;
    napi_value value; napi_get_boolean(env, pressed && modifiersMatch, &value); return value;
  }
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "setGlass", nullptr, SetGlass, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "shortcutKeyDown", nullptr, ShortcutKeyDown, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, 3, properties); return exports;
}
NAPI_MODULE(glass, Init)
