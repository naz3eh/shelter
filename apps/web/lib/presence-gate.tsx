"use client";

import { usePresence, type MotionStyle } from "motion/react";
import type { ReactNode } from "react";

export interface PresenceGateValue {
  gate: {
    style: MotionStyle;
    "data-presence"?: string;
  };
}

// Releases pointer interaction in the same commit that starts an
// AnimatePresence exit, instead of waiting for the exit animation to end.
// Render-prop wrapper: <PresenceGate>{({ gate }) => <motion.div {...gate} />}</PresenceGate>
export function PresenceGate({
  children,
}: {
  children: (value: PresenceGateValue) => ReactNode;
}) {
  const [isPresent] = usePresence();
  const style: MotionStyle = isPresent ? {} : { pointerEvents: "none" as const };
  return <>{children({ gate: { style } })}</>;
}
