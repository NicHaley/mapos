import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@mapos/ui/components/alert-dialog";
import type { ProviderView } from "@shared/ai-providers";
import { Loader2Icon } from "lucide-react";

/**
 * Confirmation dialog for removing a provider. Open while `pendingDelete` is set; shared by the
 * Settings AI Models tab and the onboarding AI step so both stay consistent. Pair with
 * {@link useProviderManager}'s delete state.
 */
export function DeleteProviderDialog({
  pendingDelete,
  deleting,
  deleteError,
  onCancel,
  onConfirm
}: {
  pendingDelete: ProviderView | null;
  deleting: boolean;
  deleteError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog
      open={!!pendingDelete}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this provider?</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingDelete?.label || "This provider"} will be removed from MapOS. No remote data is
            affected.
          </AlertDialogDescription>
          {deleteError ? (
            <AlertDialogDescription className="text-destructive">
              {deleteError}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {deleting ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
