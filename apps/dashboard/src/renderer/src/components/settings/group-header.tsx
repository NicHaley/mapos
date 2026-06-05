export function GroupHeader({
  label,
  action
}: {
  label: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-8 items-center justify-between">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {action}
    </div>
  );
}
