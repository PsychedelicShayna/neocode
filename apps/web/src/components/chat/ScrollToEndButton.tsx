import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";

export function ScrollToEndButton({ bottom, onClick }: { bottom: number; onClick: () => void }) {
  return (
    <div
      className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
      style={{ bottom }}
    >
      <Button
        aria-label="Scroll to end"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onClick}
        className="pointer-events-auto"
        size="xs"
        variant="glass"
      >
        <ChevronDownIcon className="size-3.5" />
        Scroll to end
      </Button>
    </div>
  );
}
