import {
  Bot,
  CalendarDays,
  FolderGit2,
  GitBranch,
  GitFork,
  LayoutGrid,
  List,
  MessageSquare,
  Plus,
  Users,
} from "lucide-react";
import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import {
  type Project,
  type ProjectActivitySummary,
  useProjectActivitySummariesQuery,
  useCreateProjectMutation,
  useProjectsQuery,
} from "@/features/projects/hooks";
import type { ManagedAgent, RelayAgent } from "@/shared/api/types";
import { topChromeInset } from "@/shared/layout/chromeLayout";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { CreateProjectDialog } from "./CreateProjectDialog";

type ProjectsViewMode = "grid" | "list";
type ProjectAgentInfo = {
  pubkey: string;
  name: string;
  status: string;
};

const PROJECTS_VIEW_MODE_STORAGE_KEY = "buzz.projects.viewMode";
const MANY_PROJECTS_THRESHOLD = 12;

function readStoredViewMode(): ProjectsViewMode | null {
  try {
    const value = globalThis.localStorage?.getItem(
      PROJECTS_VIEW_MODE_STORAGE_KEY,
    );
    return value === "grid" || value === "list" ? value : null;
  } catch {
    return null;
  }
}

function writeStoredViewMode(viewMode: ProjectsViewMode) {
  try {
    globalThis.localStorage?.setItem(PROJECTS_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Persistence is a convenience only; the toggle should still work.
  }
}

function formatCreatedDate(createdAt: number) {
  return new Date(createdAt * 1_000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getDiscussionLabel(project: Project) {
  return project.projectChannelId ? "Discussion linked" : "No discussion";
}

function getProjectCloneUrl(project: Project) {
  return project.cloneUrls[0] ?? "BizzHub clone URL pending";
}

function getActivityLabel(summary: ProjectActivitySummary | undefined) {
  if (!summary || summary.activityCount === 0) {
    return "No project activity yet";
  }

  return `${pluralize(summary.issueCount, "issue")} · ${pluralize(
    summary.activityCount,
    "event",
  )}`;
}

function buildAgentDirectory({
  managedAgents,
  relayAgents,
}: {
  managedAgents: ManagedAgent[] | undefined;
  relayAgents: RelayAgent[] | undefined;
}) {
  const agents = new Map<string, ProjectAgentInfo>();

  for (const agent of relayAgents ?? []) {
    agents.set(agent.pubkey.toLowerCase(), {
      pubkey: agent.pubkey,
      name: agent.name,
      status: agent.status,
    });
  }

  for (const agent of managedAgents ?? []) {
    agents.set(agent.pubkey.toLowerCase(), {
      pubkey: agent.pubkey,
      name: agent.name,
      status: agent.status,
    });
  }

  return agents;
}

function getInvolvedAgents({
  summary,
  agentDirectory,
}: {
  summary: ProjectActivitySummary | undefined;
  agentDirectory: Map<string, ProjectAgentInfo>;
}) {
  if (!summary) return [];

  return summary.participantPubkeys
    .map((pubkey) => agentDirectory.get(pubkey.toLowerCase()))
    .filter((agent): agent is ProjectAgentInfo => Boolean(agent))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
      {status}
    </span>
  );
}

function AgentInvolvement({
  agents,
  summary,
  isLoading,
  compact = false,
}: {
  agents: ProjectAgentInfo[];
  summary: ProjectActivitySummary | undefined;
  isLoading: boolean;
  compact?: boolean;
}) {
  const visibleAgents = agents.slice(0, compact ? 1 : 2);
  const hiddenCount = agents.length - visibleAgents.length;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        <Bot className="h-3.5 w-3.5" />
        Agent involvement
      </div>
      {visibleAgents.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {visibleAgents.map((agent) => (
            <span
              className="min-w-0 max-w-32 truncate rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-2xs font-medium text-foreground"
              key={agent.pubkey}
              title={`${agent.name} · ${agent.status}`}
            >
              {agent.name}
            </span>
          ))}
          {hiddenCount > 0 ? (
            <span className="text-2xs text-muted-foreground">
              +{hiddenCount}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="truncate text-xs text-muted-foreground/80">
          {isLoading
            ? "Checking project activity..."
            : summary && summary.activityCount > 0
              ? "No known agents in activity"
              : "No agent activity yet"}
        </p>
      )}
    </div>
  );
}

function MetadataItem({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground/70" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <FolderGit2 className="h-10 w-10 text-muted-foreground/40" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">No projects yet</p>
        <p className="text-sm text-muted-foreground">
          Create a BizzHub project with a linked discussion channel.
        </p>
      </div>
      <Button
        className="mt-2 gap-1.5"
        data-testid="create-project-open"
        onClick={onCreate}
      >
        <Plus className="h-4 w-4" />
        Create Project
      </Button>
    </div>
  );
}

function ProjectsViewModeToggle({
  viewMode,
  onViewModeChange,
}: {
  viewMode: ProjectsViewMode;
  onViewModeChange: (viewMode: ProjectsViewMode) => void;
}) {
  return (
    <fieldset className="flex items-center rounded-lg border border-border/60 bg-muted/30 p-1">
      <legend className="sr-only">Project layout</legend>
      <Button
        aria-pressed={viewMode === "grid"}
        className="h-7 gap-1.5 px-2"
        onClick={() => onViewModeChange("grid")}
        size="xs"
        type="button"
        variant={viewMode === "grid" ? "secondary" : "ghost"}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        Grid
      </Button>
      <Button
        aria-pressed={viewMode === "list"}
        className="h-7 gap-1.5 px-2"
        onClick={() => onViewModeChange("list")}
        size="xs"
        type="button"
        variant={viewMode === "list" ? "secondary" : "ghost"}
      >
        <List className="h-3.5 w-3.5" />
        List
      </Button>
    </fieldset>
  );
}

function ProjectsToolbar({
  projectCount,
  viewMode,
  onCreate,
  onViewModeChange,
}: {
  projectCount: number;
  viewMode: ProjectsViewMode;
  onCreate: () => void;
  onViewModeChange: (viewMode: ProjectsViewMode) => void;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 border-b border-border/50 pb-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">Projects</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {pluralize(projectCount, "project")}
          </span>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          BizzHub projects bring code, discussion, and agent work into one
          shared space.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ProjectsViewModeToggle
          onViewModeChange={onViewModeChange}
          viewMode={viewMode}
        />
        <Button
          className="gap-1.5"
          data-testid="create-project-open"
          onClick={onCreate}
          size="sm"
        >
          <Plus className="h-4 w-4" />
          Create Project
        </Button>
      </div>
    </div>
  );
}

function ProjectCardButton({
  project,
  onOpen,
}: {
  project: Project;
  onOpen: (project: Project) => void;
}) {
  return (
    <button
      className="absolute inset-0 rounded-xl"
      onClick={() => onOpen(project)}
      type="button"
    >
      <span className="sr-only">View {project.name}</span>
    </button>
  );
}

function ProjectGridCard({
  project,
  activitySummary,
  involvedAgents,
  isActivityLoading,
  onOpen,
}: {
  project: Project;
  activitySummary: ProjectActivitySummary | undefined;
  involvedAgents: ProjectAgentInfo[];
  isActivityLoading: boolean;
  onOpen: (project: Project) => void;
}) {
  return (
    <Card
      className="group relative flex min-h-48 flex-col p-3 transition-colors hover:bg-muted/45"
      data-testid={`project-card-${project.dtag}`}
    >
      <ProjectCardButton onOpen={onOpen} project={project} />
      <div className="pointer-events-none flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-semibold">
                {project.name}
              </span>
            </div>
            <p className="truncate font-mono text-2xs text-muted-foreground/70">
              {project.dtag}
            </p>
          </div>
          <StatusPill status={project.status} />
        </div>

        <p className="line-clamp-3 min-h-12 text-sm text-muted-foreground">
          {project.description || "A shared BizzHub space for code work."}
        </p>

        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <MetadataItem icon={GitBranch}>{project.defaultBranch}</MetadataItem>
          <MetadataItem icon={Users}>
            {pluralize(project.contributors.length, "contributor")}
          </MetadataItem>
          <MetadataItem icon={MessageSquare}>
            {getDiscussionLabel(project)}
          </MetadataItem>
          <MetadataItem icon={CalendarDays}>
            {formatCreatedDate(project.createdAt)}
          </MetadataItem>
        </div>

        <div className="mt-auto space-y-2 rounded-lg border border-border/50 bg-muted/25 px-2.5 py-2">
          <AgentInvolvement
            agents={involvedAgents}
            isLoading={isActivityLoading}
            summary={activitySummary}
          />
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/80">
            <GitFork className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono">
              {getProjectCloneUrl(project)}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function ProjectListRow({
  project,
  activitySummary,
  involvedAgents,
  isActivityLoading,
  onOpen,
}: {
  project: Project;
  activitySummary: ProjectActivitySummary | undefined;
  involvedAgents: ProjectAgentInfo[];
  isActivityLoading: boolean;
  onOpen: (project: Project) => void;
}) {
  return (
    <Card
      className="group relative p-3 transition-colors hover:bg-muted/45"
      data-testid={`project-row-${project.dtag}`}
    >
      <ProjectCardButton onOpen={onOpen} project={project} />
      <div className="pointer-events-none grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(14rem,1fr)_auto] lg:items-center">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-semibold">
              {project.name}
            </span>
            <StatusPill status={project.status} />
          </div>
          <p className="line-clamp-1 text-sm text-muted-foreground">
            {project.description || "A shared BizzHub space for code work."}
          </p>
        </div>

        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <MetadataItem icon={GitBranch}>
              {project.defaultBranch}
            </MetadataItem>
            <MetadataItem icon={Users}>
              {pluralize(project.contributors.length, "contributor")}
            </MetadataItem>
            <MetadataItem icon={MessageSquare}>
              {getDiscussionLabel(project)}
            </MetadataItem>
            <MetadataItem icon={Bot}>
              {getActivityLabel(activitySummary)}
            </MetadataItem>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/75">
            <GitFork className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono">
              {getProjectCloneUrl(project)}
            </span>
          </div>
        </div>

        <div className="min-w-0 space-y-1 text-left lg:text-right">
          <AgentInvolvement
            agents={involvedAgents}
            compact
            isLoading={isActivityLoading}
            summary={activitySummary}
          />
          <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Created {formatCreatedDate(project.createdAt)}
          </p>
        </div>
      </div>
    </Card>
  );
}

export function ProjectsView() {
  const { goProject } = useAppNavigation();
  const projectsQuery = useProjectsQuery();
  const createProjectMutation = useCreateProjectMutation();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [storedViewMode, setStoredViewMode] =
    React.useState<ProjectsViewMode | null>(() => readStoredViewMode());
  const projects = projectsQuery.data ?? [];
  const activitySummariesQuery = useProjectActivitySummariesQuery(projects);
  const relayAgentsQuery = useRelayAgentsQuery({
    enabled: projects.length > 0,
  });
  const managedAgentsQuery = useManagedAgentsQuery({
    enabled: projects.length > 0,
  });
  const agentDirectory = React.useMemo(
    () =>
      buildAgentDirectory({
        managedAgents: managedAgentsQuery.data,
        relayAgents: relayAgentsQuery.data,
      }),
    [managedAgentsQuery.data, relayAgentsQuery.data],
  );
  const viewMode =
    storedViewMode ??
    (projects.length > MANY_PROJECTS_THRESHOLD ? "list" : "grid");

  const handleViewModeChange = React.useCallback(
    (nextViewMode: ProjectsViewMode) => {
      setStoredViewMode(nextViewMode);
      writeStoredViewMode(nextViewMode);
    },
    [],
  );

  const handleOpenProject = React.useCallback(
    (project: Project) => {
      void goProject(project.dtag);
    },
    [goProject],
  );

  if (projectsQuery.isLoading) {
    return null;
  }

  if (projectsQuery.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <p className="text-sm text-red-400">Failed to load projects</p>
        <Button
          onClick={() => void projectsQuery.refetch()}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <>
        <EmptyState onCreate={() => setCreateOpen(true)} />
        <CreateProjectDialog
          isCreating={createProjectMutation.isPending}
          onCreate={async (input) => {
            const project = await createProjectMutation.mutateAsync(input);
            await goProject(project.dtag);
          }}
          onOpenChange={setCreateOpen}
          open={createOpen}
        />
      </>
    );
  }

  return (
    <>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4",
          topChromeInset.padding,
        )}
      >
        <ProjectsToolbar
          onCreate={() => setCreateOpen(true)}
          onViewModeChange={handleViewModeChange}
          projectCount={projects.length}
          viewMode={viewMode}
        />

        {viewMode === "grid" ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <ProjectGridCard
                activitySummary={
                  activitySummariesQuery.data?.[project.repoAddress]
                }
                involvedAgents={getInvolvedAgents({
                  agentDirectory,
                  summary: activitySummariesQuery.data?.[project.repoAddress],
                })}
                isActivityLoading={
                  activitySummariesQuery.isLoading ||
                  relayAgentsQuery.isLoading ||
                  managedAgentsQuery.isLoading
                }
                key={project.id}
                onOpen={handleOpenProject}
                project={project}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {projects.map((project) => (
              <ProjectListRow
                activitySummary={
                  activitySummariesQuery.data?.[project.repoAddress]
                }
                involvedAgents={getInvolvedAgents({
                  agentDirectory,
                  summary: activitySummariesQuery.data?.[project.repoAddress],
                })}
                isActivityLoading={
                  activitySummariesQuery.isLoading ||
                  relayAgentsQuery.isLoading ||
                  managedAgentsQuery.isLoading
                }
                key={project.id}
                onOpen={handleOpenProject}
                project={project}
              />
            ))}
          </div>
        )}
      </div>
      <CreateProjectDialog
        isCreating={createProjectMutation.isPending}
        onCreate={async (input) => {
          const project = await createProjectMutation.mutateAsync(input);
          await goProject(project.dtag);
        }}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />
    </>
  );
}
