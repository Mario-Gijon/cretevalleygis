import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

function Switch({
  className,
  ...props
}: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn("layer-switch", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb className="layer-switch__thumb" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
