import type { ReactNode } from "react";
import { Bot, BookOpen, FolderKanban, Library, Plus, RefreshCw, Settings2 } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  SidebarInset,
} from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { CommandPalette } from "./command-palette";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../ui/breadcrumb";

type AppShellProps = {
  children: ReactNode;
  projectId?: string | null;
  route?: string;
  onRefresh?: () => void;
  onNewProject?: () => void;
  onChat?: () => void;
};

const projectRoute = (projectId: string, route: string) => `/project/${encodeURIComponent(projectId)}/${route}`;

const routeLabels: Record<string, string> = {
  overview: "项目总览",
  "studio/foundation": "Foundation",
  "studio/chapters": "章节创作",
  "studio/final-review": "全书终审",
  "library/settings": "Foundation 文档",
  "library/chapters": "章节文稿",
  "library/reviews": "审稿记录",
  runs: "运行中心",
};

export function AppShell({ children, projectId, route = "", onRefresh, onNewProject, onChat }: AppShellProps) {
  const projectLink = projectId ? projectRoute(projectId, "overview") : "/";
  const projectItems = projectId ? [
    ["项目总览", "overview", FolderKanban],
    ["创作台", "studio/foundation", BookOpen],
    ["内容库", "library/settings", Library],
    ["运行中心", "runs", Settings2],
  ] as const : [];
  const active = (path: string) => projectId ? route === path || route.startsWith(`${path}/`) : false;
  const isReader = !projectId && route === "reader";
  return <TooltipProvider>
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader className="h-16 border-b">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="lg" tooltip="GraphNovel">
                <a href={projectLink}>
                  <img src="/favicon.svg" alt="" aria-hidden="true" className="size-8 shrink-0 rounded-md" />
                  <span className="min-w-0 group-data-[collapsible=icon]:hidden"><strong className="block truncate text-sm tracking-wide">GRAPHNOVEL</strong><span className="block truncate text-[10px] text-muted-foreground">AI STORY SYSTEM</span></span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>工作台</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem><SidebarMenuButton asChild isActive={!projectId && !isReader} tooltip="项目库"><a href="/"><FolderKanban /><span>项目库</span></a></SidebarMenuButton></SidebarMenuItem>
                <SidebarMenuItem><SidebarMenuButton asChild isActive={isReader} tooltip="试读中心"><a href="/reader"><Library /><span>试读中心</span></a></SidebarMenuButton></SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {projectId && <>
            <SidebarSeparator />
            <SidebarGroup>
              <SidebarGroupLabel className="truncate">当前项目</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>{projectItems.map(([label, path, Icon]) => <SidebarMenuItem key={path}><SidebarMenuButton asChild isActive={active(path)} tooltip={label}><a href={projectRoute(projectId, path)}><Icon /><span>{label}</span></a></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </>}
        </SidebarContent>
        <SidebarFooter>
          {onNewProject && <SidebarMenu><SidebarMenuItem><SidebarMenuButton onClick={onNewProject} tooltip="新建项目"><Plus /><span>新建项目</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>}
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur sm:px-6">
          <SidebarTrigger aria-label="切换侧边栏" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <div className="min-w-0 flex-1 overflow-hidden">
            <Breadcrumb>
              <BreadcrumbList className="flex-nowrap text-sm">
                <BreadcrumbItem>
                  {isReader ? <BreadcrumbLink href="/">小说项目</BreadcrumbLink> : <BreadcrumbPage>小说项目</BreadcrumbPage>}
                </BreadcrumbItem>
                {isReader && <><BreadcrumbSeparator /><BreadcrumbItem><BreadcrumbPage>试读中心</BreadcrumbPage></BreadcrumbItem></>}
                {projectId && <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem className="min-w-0">
                    {route === "overview" ? <BreadcrumbPage className="truncate">项目工作区</BreadcrumbPage> : <BreadcrumbLink className="truncate" href={projectRoute(projectId, "overview")}>项目工作区</BreadcrumbLink>}
                  </BreadcrumbItem>
                  {route && route !== "overview" && <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem className="min-w-0"><BreadcrumbPage className="truncate">{routeLabels[route] ?? route}</BreadcrumbPage></BreadcrumbItem>
                  </>}
                </>}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <CommandPalette projectId={projectId} onChat={onChat} />
          <div className="flex items-center gap-1">
            {onRefresh && <Button variant="ghost" size="icon" onClick={onRefresh} aria-label="刷新" title="刷新"><RefreshCw /></Button>}
            {onChat && <Button variant="ghost" size="sm" onClick={onChat}><Bot data-icon="inline-start" />创意助手</Button>}
            {onNewProject && <Button size="sm" onClick={onNewProject}><Plus data-icon="inline-start" />新建项目</Button>}
          </div>
        </header>
        <div className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  </TooltipProvider>;
}
