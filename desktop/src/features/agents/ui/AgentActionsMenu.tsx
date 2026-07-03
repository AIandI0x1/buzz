import {
  BookmarkPlus,
  CopyPlus,
  Ellipsis,
  FileDown,
  MessageSquarePlus,
  Pencil,
  Trash2,
} from "lucide-react";

import type { ManagedAgent } from "@/shared/api/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

export function AgentActionsMenu({
  agent,
  disabled,
  onAddToChannel,
  onDelete,
  onDuplicate,
  onEdit,
  onExport,
  onSaveAsTemplate,
}: {
  agent: ManagedAgent;
  disabled: boolean;
  onAddToChannel: (agent: ManagedAgent) => void;
  onDelete: (agent: ManagedAgent) => void;
  onDuplicate: (agent: ManagedAgent) => void;
  onEdit: (agent: ManagedAgent) => void;
  onExport: (agent: ManagedAgent) => void;
  onSaveAsTemplate: (agent: ManagedAgent) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Open actions for ${agent.name}`}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          type="button"
        >
          <Ellipsis className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuItem disabled={disabled} onClick={() => onEdit(agent)}>
          <Pencil className="h-4 w-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onClick={() => onDuplicate(agent)}
        >
          <CopyPlus className="h-4 w-4" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onClick={() => onAddToChannel(agent)}
        >
          <MessageSquarePlus className="h-4 w-4" />
          Add to channel
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onClick={() => onSaveAsTemplate(agent)}
        >
          <BookmarkPlus className="h-4 w-4" />
          Save as template
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onClick={() => onExport(agent)}>
          <FileDown className="h-4 w-4" />
          Export
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          disabled={disabled}
          onClick={() => onDelete(agent)}
        >
          <Trash2 className="h-4 w-4" />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
