// beui.dev internal: shared constant for touch drag surfaces.
// Disables the iOS long-press callout and text selection so a slow pull on a
// drag handle is not stolen by the native gesture.
export const TOUCH_GESTURE_CONTENT_CLASS =
  "select-none [-webkit-touch-callout:none] [-webkit-user-select:none]";
