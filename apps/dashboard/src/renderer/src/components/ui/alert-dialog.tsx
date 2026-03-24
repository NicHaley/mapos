import type * as React from "react";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@renderer/components/ui/dialog";
import { cn } from "@renderer/lib/utils";

function AlertDialog(props: React.ComponentProps<typeof Dialog>) {
  return <Dialog {...props} />;
}

function AlertDialogContent(props: React.ComponentProps<typeof DialogContent>) {
  return <DialogContent showCloseButton={false} {...props} />;
}

function AlertDialogHeader(props: React.ComponentProps<typeof DialogHeader>) {
  return <DialogHeader {...props} />;
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<typeof DialogFooter>) {
  return <DialogFooter className={cn("sm:justify-end", className)} {...props} />;
}

function AlertDialogTitle(props: React.ComponentProps<typeof DialogTitle>) {
  return <DialogTitle {...props} />;
}

function AlertDialogDescription(props: React.ComponentProps<typeof DialogDescription>) {
  return <DialogDescription {...props} />;
}

function AlertDialogAction({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button className={cn(className)} {...props} />;
}

function AlertDialogCancel({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button variant="outline" className={cn(className)} {...props} />;
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
};
