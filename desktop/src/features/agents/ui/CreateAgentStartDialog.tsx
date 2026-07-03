import { FileUp, Plus } from "lucide-react";
import * as React from "react";

import { useAgentTemplatesQuery } from "@/features/agents/hooks";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import type { AgentTemplate } from "@/shared/api/types";
import { useFileImportZone } from "@/shared/hooks/useFileImportZone";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Markdown } from "@/shared/ui/markdown";
import { Skeleton } from "@/shared/ui/skeleton";

const agentInstructionMarkdownClassName = [
  "mt-3 leading-6 text-muted-foreground [&_blockquote]:!text-muted-foreground [&_code]:!text-muted-foreground [&_li]:text-muted-foreground [&_ol]:text-muted-foreground [&_p]:text-muted-foreground [&_strong]:text-muted-foreground [&_td]:text-muted-foreground [&_ul]:text-muted-foreground",
  "[&>h1]:!text-sm [&>h1]:!font-semibold [&>h1]:!leading-6 [&>h1]:!tracking-normal [&>h1]:!text-foreground",
  "[&>h2]:!text-sm [&>h2]:!font-semibold [&>h2]:!leading-6 [&>h2]:!tracking-normal [&>h2]:!text-foreground",
  "[&>h3]:!text-sm [&>h3]:!font-semibold [&>h3]:!leading-6 [&>h3]:!tracking-normal [&>h3]:!text-foreground",
  "[&>h4]:!text-sm [&>h4]:!font-semibold [&>h4]:!leading-6 [&>h4]:!tracking-normal [&>h4]:!text-foreground",
  "[&>h5]:!text-sm [&>h5]:!font-semibold [&>h5]:!leading-6 [&>h5]:!tracking-normal [&>h5]:!text-foreground",
  "[&>h6]:!text-sm [&>h6]:!font-semibold [&>h6]:!leading-6 [&>h6]:!tracking-normal [&>h6]:!text-foreground",
].join(" ");

const sidebarRowClassName =
  "flex w-full items-center gap-2 rounded-lg px-4 py-1.5 text-left transition-[background-color,color,box-shadow] focus:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar";

const sidebarRowIdleClassName =
  "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

/**
 * Step 1 of the Create Agent wizard: choose a starting point — a blank
 * agent, a built-in starter template, or an imported agent file. Uses the
 * catalog chooser layout: a sidebar list on the left and a template detail
 * pane on the right. Blank/import act immediately; picking a template
 * previews it and "Use template" hands off to the details step
 * (CreateAgentDialog) prefilled.
 */
export function CreateAgentStartDialog({
  open,
  onImportFile,
  onOpenChange,
  onPickBlank,
  onPickTemplate,
}: {
  open: boolean;
  onImportFile: (fileBytes: number[], fileName: string) => void;
  onOpenChange: (open: boolean) => void;
  onPickBlank: () => void;
  onPickTemplate: (template: AgentTemplate) => void;
}) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const templatesQuery = useAgentTemplatesQuery({ enabled: open });
  const templates = templatesQuery.data ?? [];
  const isLoading = templatesQuery.isLoading;
  const error =
    templatesQuery.error instanceof Error ? templatesQuery.error : null;
  const {
    fileInputRef,
    isDragOver,
    dropHandlers,
    handleFileChange,
    openFilePicker,
  } = useFileImportZone({ onImportFile });

  const [selectedTemplateId, setSelectedTemplateId] = React.useState<
    string | null
  >(null);
  const selectedTemplate = React.useMemo(() => {
    if (templates.length === 0) {
      return null;
    }

    return (
      templates.find((template) => template.id === selectedTemplateId) ??
      templates[0]
    );
  }, [templates, selectedTemplateId]);
  const builtinTemplates = templates.filter(
    (template) => template.source === "builtin",
  );
  const savedTemplates = templates.filter(
    (template) => template.source === "saved",
  );

  React.useEffect(() => {
    if (!open) {
      return;
    }

    if (templates.length === 0) {
      setSelectedTemplateId(null);
      return;
    }

    setSelectedTemplateId((current) =>
      current && templates.some((template) => template.id === current)
        ? current
        : templates[0].id,
    );
  }, [open, templates]);

  const handleUseTemplate = () => {
    if (!selectedTemplate) {
      return;
    }

    onPickTemplate(selectedTemplate);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <ChooserDialogContent
        className="h-168 max-w-4xl"
        contentClassName="flex min-h-0 flex-1 p-0"
        data-testid="create-agent-start-dialog"
        description="Choose a starting point. You can adjust everything in the next step."
        headerClassName="bg-sidebar pb-3 text-sidebar-foreground"
        headerTestId="create-agent-start-dialog-header"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        ref={contentRef}
        scrollAreaClassName="flex min-h-0 overflow-hidden px-0"
        scrollAreaTestId="create-agent-start-dialog-body"
        tabIndex={-1}
        title="New agent"
        {...dropHandlers}
      >
        {isDragOver ? (
          <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-background/80 backdrop-blur-sm">
            <p className="text-sm font-medium text-primary">
              Drop an agent file to import
            </p>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-sidebar sm:flex-row">
          <div className="flex max-h-56 min-h-0 flex-col sm:max-h-none sm:w-56">
            <div
              className="min-h-0 flex-1 overflow-y-auto px-2 py-3"
              data-testid="create-agent-start-dialog-scroll-area"
            >
              <div className="space-y-1">
                <button
                  className={cn(sidebarRowClassName, sidebarRowIdleClassName)}
                  data-testid="create-agent-start-blank"
                  onClick={onPickBlank}
                  type="button"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/40">
                    <Plus className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    Blank agent
                  </span>
                </button>

                <button
                  className={cn(sidebarRowClassName, sidebarRowIdleClassName)}
                  data-testid="create-agent-start-import"
                  onClick={openFilePicker}
                  type="button"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/40">
                    <FileUp className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    Import from file
                  </span>
                </button>
              </div>

              <p className="px-4 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/60">
                Templates
              </p>

              {isLoading ? <TemplateListSkeleton /> : null}

              {!isLoading && builtinTemplates.length > 0 ? (
                <div className="space-y-1">
                  {builtinTemplates.map((template) => (
                    <TemplateRow
                      isCurrent={template.id === selectedTemplate?.id}
                      key={template.id}
                      onSelect={setSelectedTemplateId}
                      template={template}
                    />
                  ))}
                </div>
              ) : null}

              {!isLoading && savedTemplates.length > 0 ? (
                <>
                  <p className="px-4 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/60">
                    Saved
                  </p>
                  <div className="space-y-1">
                    {savedTemplates.map((template) => (
                      <TemplateRow
                        isCurrent={template.id === selectedTemplate?.id}
                        key={template.id}
                        onSelect={setSelectedTemplateId}
                        template={template}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="relative z-10 ml-px flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-xl bg-background shadow-[-1px_0_0_0_hsl(var(--sidebar-border)/0.45)]">
            <div
              className="min-h-0 flex-1 overflow-y-auto px-5 pb-24 pt-5"
              data-testid="create-agent-start-detail-pane"
            >
              {isLoading ? <TemplateDetailSkeleton /> : null}

              {!isLoading && selectedTemplate ? (
                <TemplateDetail template={selectedTemplate} />
              ) : null}

              {!isLoading && templates.length === 0 && !error ? (
                <div className="flex min-h-80 items-center justify-center rounded-lg border border-dashed border-border/70 px-6 text-center">
                  <div>
                    <p className="text-sm font-semibold">
                      No templates available
                    </p>
                    <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                      Start from a blank agent or import an agent file instead.
                    </p>
                  </div>
                </div>
              ) : null}

              {error ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error.message}
                </p>
              ) : null}
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end bg-linear-to-t from-background via-background/95 to-transparent px-5 pb-4 pt-12">
              <Button
                aria-label={
                  selectedTemplate
                    ? `Use the ${selectedTemplate.displayName} template`
                    : undefined
                }
                className="pointer-events-auto"
                data-testid="create-agent-start-use-template"
                disabled={!selectedTemplate}
                onClick={handleUseTemplate}
                size="sm"
                type="button"
              >
                Use template
              </Button>
            </div>
          </div>
        </div>

        <input
          accept=".md,.json,.png,.zip"
          className="hidden"
          onChange={handleFileChange}
          ref={fileInputRef}
          type="file"
        />
      </ChooserDialogContent>
    </Dialog>
  );
}

function TemplateRow({
  template,
  isCurrent,
  onSelect,
}: {
  template: AgentTemplate;
  isCurrent: boolean;
  onSelect: (templateId: string) => void;
}) {
  return (
    <button
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        sidebarRowClassName,
        isCurrent
          ? "bg-sidebar-active text-sidebar-active-foreground"
          : sidebarRowIdleClassName,
      )}
      data-testid={`create-agent-template-${template.id}`}
      onClick={() => {
        onSelect(template.id);
      }}
      type="button"
    >
      <ProfileAvatar
        avatarUrl={template.avatarUrl}
        className="h-6 w-6 text-3xs"
        label={template.displayName}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {template.displayName}
      </span>
    </button>
  );
}

function TemplateDetail({ template }: { template: AgentTemplate }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ProfileAvatar
          avatarUrl={template.avatarUrl}
          className="h-12 w-12 text-sm"
          label={template.displayName}
        />
        <div className="min-w-0">
          <h3 className="truncate text-xl font-semibold leading-snug">
            {template.displayName}
          </h3>
        </div>
      </div>

      <TemplateMetaGroup
        items={[
          {
            label: "Type",
            value:
              template.source === "saved"
                ? "Saved template"
                : "Built-in template",
          },
          {
            label: "Preferred model",
            value: template.model ?? "Use app default",
          },
          {
            label: "Preferred runtime",
            value: template.runtime ?? "Use app default",
          },
        ]}
      />

      <div className="pt-3">
        <p className="text-base font-semibold text-foreground">
          Agent instruction
        </p>
        <Markdown
          className={agentInstructionMarkdownClassName}
          content={template.systemPrompt}
          interactive={false}
        />
      </div>
    </div>
  );
}

function TemplateMetaGroup({
  items,
}: {
  items: { label: string; value: string }[];
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-card/70">
      <div className="grid sm:grid-cols-3">
        {items.map((item, index) => (
          <div
            className={cn(
              "relative px-4 py-3",
              index > 0 &&
                "border-t border-border/60 sm:border-t-0 sm:before:absolute sm:before:bottom-3 sm:before:left-0 sm:before:top-3 sm:before:w-px sm:before:bg-border/70",
            )}
            key={item.label}
          >
            <p className="text-xs font-semibold text-muted-foreground">
              {item.label}
            </p>
            <p className="mt-2 text-sm font-medium text-foreground">
              {item.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateListSkeleton() {
  return (
    <div className="space-y-2">
      {["first", "second", "third", "fourth", "fifth"].map((key) => (
        <div
          className="flex items-center gap-2 rounded-lg px-4 py-1.5"
          key={key}
        >
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-4 w-28" />
        </div>
      ))}
    </div>
  );
}

function TemplateDetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-12 w-12 rounded-full" />
        <Skeleton className="h-6 w-40" />
      </div>
      <div className="grid overflow-hidden rounded-lg border border-border/70 sm:grid-cols-3">
        <Skeleton className="h-20 rounded-none" />
        <Skeleton className="h-20 rounded-none" />
        <Skeleton className="h-20 rounded-none" />
      </div>
      <Skeleton className="h-48 rounded-lg" />
    </div>
  );
}
