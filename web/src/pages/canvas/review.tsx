import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { App, Button, Empty, Input, Progress, Segmented, Spin, Tag, Tooltip } from "antd";
import {
    ArrowLeft,
    Check,
    ChevronLeft,
    ChevronRight,
    Download,
    FolderOpen,
    ImagePlus,
    LoaderCircle,
    RefreshCw,
    Search,
    Trash2,
    Upload,
    Video,
    X,
} from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { requestEdit, requestGeneration } from "@/services/api/image";
import {
    addStoryReviewReference,
    addStoryReviewVersion,
    fetchStoryReviewExportJob,
    fetchStoryReviewProject,
    removeStoryReviewReference,
    revealStoryReviewExport,
    selectStoryReviewVersion,
    setStoryReviewStatus,
    startStoryReviewExport,
    storyReviewCustomReferenceImageUrl,
    storyReviewExportFileUrl,
    storyReviewReferenceImageUrl,
    storyReviewVersionImageUrl,
} from "@/services/api/story-review";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import type { ReferenceImage } from "@/types/image";
import type { StoryReviewExportJob, StoryReviewProject, StoryReviewShot, StoryReviewStatus } from "@/types/story-review";

type Filter = "all" | "pending" | "approved" | "needs_changes" | "changed";
type RegenerationMode = "repair" | "reshoot";
type GenerationReferenceDescriptor = {
    id: string;
    role: string;
    label: string;
    source: "current" | "custom" | "system";
    customReferenceId?: string;
};

export default function CanvasReviewPage() {
    const { id = "" } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { message, modal } = App.useApp();
    const replacementInputRef = useRef<HTMLInputElement>(null);
    const generationReferenceInputRef = useRef<HTMLInputElement>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const agentToken = useAgentStore((state) => state.token);
    const [project, setProject] = useState<StoryReviewProject | null>(null);
    const [selectedShotId, setSelectedShotId] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [mode, setMode] = useState<RegenerationMode>("repair");
    const [instruction, setInstruction] = useState("");
    const [reviewNote, setReviewNote] = useState("");
    const [generating, setGenerating] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [referenceUploading, setReferenceUploading] = useState(false);
    const [referenceLabel, setReferenceLabel] = useState("");
    const [exportJob, setExportJob] = useState<StoryReviewExportJob | null>(null);
    const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
    const model = effectiveConfig.imageModel || effectiveConfig.model;

    useEffect(() => {
        void loadProject();
    }, [id, agentToken]);

    const selectedShot = project?.shots.find((shot) => shot.id === selectedShotId) || project?.shots[0] || null;
    useEffect(() => {
        if (selectedShot) {
            setReviewNote(selectedShot.reviewNote || "");
            setReferenceLabel("");
        }
    }, [selectedShot?.id, selectedShot?.reviewNote]);

    const filteredShots = useMemo(() => {
        const query = search.trim().toLowerCase();
        return (project?.shots || []).filter((shot) => {
            const matchesFilter = filter === "all" || (filter === "changed" ? shot.versions.length > 1 : shot.reviewStatus === filter);
            const matchesSearch = !query || `${shot.id} ${shot.sceneId} ${shot.function} ${shot.visual} ${shot.narration.sourceExcerpt}`.toLowerCase().includes(query);
            return matchesFilter && matchesSearch;
        });
    }, [filter, project?.shots, search]);

    async function loadProject() {
        if (!id) return;
        setLoading(true);
        setError("");
        try {
            const next = await fetchStoryReviewProject(id);
            setProject(next);
            if (!next.shots.some((shot) => shot.id === selectedShotId)) setSelectedShotId(next.shots[0]?.id || "");
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "审核项目读取失败");
        } finally {
            setLoading(false);
        }
    }

    async function regenerate() {
        if (!project || !selectedShot) return;
        if (!instruction.trim()) {
            message.warning("请先说明需要修改的问题");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成生图模型配置");
            openConfigDialog(true);
            return;
        }
        setGenerating(true);
        try {
            const referencePlan = buildReferenceDescriptors(selectedShot, mode);
            const references = buildReferences(project, selectedShot, referencePlan);
            const prompt = buildRegenerationPrompt(project, selectedShot, mode, instruction.trim(), referencePlan);
            const requestConfig = { ...effectiveConfig, model, imageModel: model, count: "1" };
            const result = references.length ? await requestEdit(requestConfig, prompt, references) : await requestGeneration(requestConfig, prompt);
            const generated = result[0]?.dataUrl;
            if (!generated) throw new Error("模型没有返回图片");
            const normalized = await normalizeTo16x9(generated);
            const next = await addStoryReviewVersion(project.id, selectedShot.id, {
                dataUrl: normalized.dataUrl,
                source: "generated",
                width: normalized.width,
                height: normalized.height,
                prompt,
                model,
                note: instruction.trim(),
                select: true,
                referenceIds: referencePlan.flatMap((reference) => reference.customReferenceId ? [reference.customReferenceId] : []),
            });
            setProject(next);
            setInstruction("");
            message.success(`${selectedShot.id} 已生成新版本，时间戳保持不变`);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "重新生成失败");
        } finally {
            setGenerating(false);
        }
    }

    async function uploadGenerationReference(file?: File) {
        if (!project || !selectedShot || !file) return;
        if (!file.type.startsWith("image/")) {
            message.error("请选择图片文件");
            return;
        }
        const label = referenceLabel.trim();
        if (!label) {
            message.warning("请先填写参考图对应的人物或对象，例如：父亲");
            return;
        }
        if (selectedShot.customReferences.filter((reference) => reference.active).length >= 4) {
            message.warning("单个镜头最多启用 4 张用户参考图，请先移除不需要的参考图");
            return;
        }
        setReferenceUploading(true);
        try {
            const prepared = await prepareReferenceImage(await fileToDataUrl(file));
            const next = await addStoryReviewReference(project.id, selectedShot.id, {
                dataUrl: prepared.dataUrl,
                width: prepared.width,
                height: prepared.height,
                label,
            });
            setProject(next);
            setReferenceLabel("");
            message.success(`已添加“${label}”参考图，生成时会自动传入`);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "参考图上传失败");
        } finally {
            setReferenceUploading(false);
            if (generationReferenceInputRef.current) generationReferenceInputRef.current.value = "";
        }
    }

    async function removeGenerationReference(referenceId: string) {
        if (!project || !selectedShot) return;
        try {
            setProject(await removeStoryReviewReference(project.id, selectedShot.id, referenceId));
            message.success("参考图已从后续生成中移除，历史版本记录仍保留");
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "参考图移除失败");
        }
    }

    async function uploadReplacement(file?: File) {
        if (!project || !selectedShot || !file) return;
        if (!file.type.startsWith("image/")) {
            message.error("请选择图片文件");
            return;
        }
        setUploading(true);
        try {
            const normalized = await normalizeTo16x9(await fileToDataUrl(file));
            const next = await addStoryReviewVersion(project.id, selectedShot.id, {
                dataUrl: normalized.dataUrl,
                source: "uploaded",
                width: normalized.width,
                height: normalized.height,
                note: instruction.trim() || `人工替换：${file.name}`,
                select: true,
            });
            setProject(next);
            message.success(`${selectedShot.id} 已替换为人工图片，时间戳保持不变`);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "图片替换失败");
        } finally {
            setUploading(false);
            if (replacementInputRef.current) replacementInputRef.current.value = "";
        }
    }

    async function chooseVersion(versionId: string) {
        if (!project || !selectedShot || versionId === selectedShot.selectedVersionId) return;
        try {
            setProject(await selectStoryReviewVersion(project.id, selectedShot.id, versionId));
            message.success(`已选择 ${selectedShot.id} ${versionId}`);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "版本切换失败");
        }
    }

    async function setStatus(status: StoryReviewStatus) {
        if (!project || !selectedShot) return;
        try {
            setProject(await setStoryReviewStatus(project.id, selectedShot.id, status, reviewNote));
            message.success(status === "approved" ? `${selectedShot.id} 已通过` : `${selectedShot.id} 已标记待修改`);
            if (status === "approved") selectAdjacent(1);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "审核状态保存失败");
        }
    }

    function selectAdjacent(offset: number) {
        if (!project || !selectedShot) return;
        const next = project.shots[Math.max(0, Math.min(project.shots.length - 1, selectedShot.index - 1 + offset))];
        if (next) setSelectedShotId(next.id);
    }

    function requestExport() {
        if (!project) return;
        const run = () => void exportThreeFiles();
        if (project.stats.pending) {
            modal.confirm({
                title: `仍有 ${project.stats.pending} 个镜头未通过`,
                content: "导出会冻结当前所有选版，但不会改变任何镜头时间戳。是否继续？",
                okText: "按当前选版导出",
                cancelText: "继续审核",
                onOk: run,
            });
        } else run();
    }

    async function exportThreeFiles() {
        if (!project) return;
        try {
            let job = await startStoryReviewExport(project.id);
            setExportJob(job);
            while (job.status === "running") {
                await delay(1800);
                job = await fetchStoryReviewExportJob(project.id, job.id);
                setExportJob(job);
            }
            if (job.status === "failed") throw new Error(job.error || "视频重建失败");
            await loadProject();
            message.success("三件套已按固定时间线导出");
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "导出失败");
        }
    }

    if (loading) return <main className="grid h-full min-h-0 place-items-center bg-stone-100 dark:bg-stone-950"><Spin size="large" /></main>;
    if (error || !project || !selectedShot) {
        return (
            <main className="grid h-full min-h-0 place-items-center bg-stone-100 p-6 dark:bg-stone-950">
                <Empty description={error || "没有可审核镜头"}>
                    <div className="flex justify-center gap-2"><Button onClick={() => navigate(`/canvas/${id}`)}>返回画布</Button><Button type="primary" onClick={() => void loadProject()}>重新读取</Button></div>
                </Empty>
            </main>
        );
    }

    const latestExport = project.exports[0];
    const activeCustomReferences = selectedShot.customReferences.filter((reference) => reference.active);
    const generationReferencePlan = buildReferenceDescriptors(selectedShot, mode);
    return (
        <main className="flex h-full min-h-0 flex-col overflow-hidden bg-stone-100 text-stone-950 dark:bg-stone-950 dark:text-stone-100">
            <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-stone-200 bg-white px-4 dark:border-stone-800 dark:bg-stone-900">
                <div className="flex min-w-0 items-center gap-3">
                    <Tooltip title="返回画布"><Button type="text" shape="circle" icon={<ArrowLeft className="size-4" />} onClick={() => navigate(`/canvas/${id}`)} /></Tooltip>
                    <div className="min-w-0"><h1 className="truncate text-sm font-semibold">{project.title} · 镜头审核</h1><p className="truncate text-xs text-stone-500">{formatTime(project.timeline.totalSeconds)} · {project.stats.total} 镜头 · 时间线已锁定</p></div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                    <div className="hidden w-44 md:block"><Progress percent={Math.round((project.stats.approved / project.stats.total) * 100)} size="small" format={() => `${project.stats.approved}/${project.stats.total}`} /></div>
                    {exportJob?.status === "running" ? <Tag icon={<LoaderCircle className="size-3 animate-spin" />}>重建 {Math.round(exportJob.progress * 100)}% · {exportJob.currentShot || "准备中"}</Tag> : null}
                    <Button icon={<Video className="size-4" />} type="primary" loading={exportJob?.status === "running"} onClick={requestExport}>导出三件套</Button>
                </div>
            </header>

            <section className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_340px] overflow-hidden max-xl:grid-cols-[240px_minmax(0,1fr)_320px] max-lg:grid-cols-[220px_minmax(0,1fr)] max-sm:grid-cols-1">
                <aside className="flex min-h-0 flex-col border-r border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900 max-sm:hidden">
                    <div className="space-y-2 border-b border-stone-200 p-3 dark:border-stone-800">
                        <Input prefix={<Search className="size-4 text-stone-400" />} placeholder="镜头、场景或台词" value={search} onChange={(event) => setSearch(event.target.value)} allowClear />
                        <Segmented block size="small" value={filter} onChange={(value) => setFilter(value as Filter)} options={[{ label: "全部", value: "all" }, { label: "待审", value: "pending" }, { label: "待改", value: "needs_changes" }, { label: "已改", value: "changed" }]} />
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-2">
                        {filteredShots.map((shot) => <ShotListItem key={shot.id} projectId={project.id} shot={shot} active={shot.id === selectedShot.id} onClick={() => setSelectedShotId(shot.id)} />)}
                        {!filteredShots.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配镜头" /> : null}
                    </div>
                </aside>

                <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 xl:p-6">
                        <div className="mx-auto flex w-full max-w-5xl items-center justify-between pb-3">
                            <div className="flex min-w-0 items-center gap-2"><StatusDot status={selectedShot.reviewStatus} /><strong>{selectedShot.id}</strong><Tag>{selectedShot.sceneId}</Tag><span className="truncate text-sm text-stone-500">{selectedShot.function}</span></div>
                            <div className="flex gap-1"><Button className="lg:hidden" size="small" onClick={() => setMobileInspectorOpen(true)}>修改</Button><Tooltip title="上一镜"><Button type="text" shape="circle" icon={<ChevronLeft className="size-4" />} disabled={selectedShot.index <= 1} onClick={() => selectAdjacent(-1)} /></Tooltip><Tooltip title="下一镜"><Button type="text" shape="circle" icon={<ChevronRight className="size-4" />} disabled={selectedShot.index >= project.shots.length} onClick={() => selectAdjacent(1)} /></Tooltip></div>
                        </div>
                        <div className="mx-auto aspect-video w-full max-w-5xl shrink-0 overflow-hidden bg-stone-950 shadow-sm">
                            <img key={`${selectedShot.id}:${selectedShot.selectedVersionId}`} src={storyReviewVersionImageUrl(project.id, selectedShot.id, selectedShot.selectedVersionId)} alt={`${selectedShot.id} 当前画面`} className="h-full w-full object-contain" />
                        </div>
                        <div className="mx-auto grid w-full max-w-5xl grid-cols-[180px_minmax(0,1fr)] gap-x-5 gap-y-3 border-b border-stone-200 py-4 text-sm dark:border-stone-800">
                            <span className="text-stone-500">固定时间</span><span className="font-mono">{formatTimestamp(selectedShot.narration.startSeconds)} → {formatTimestamp(selectedShot.narration.endSeconds)} · {selectedShot.narration.durationSeconds.toFixed(2)} 秒 · {selectedShot.narration.endFrame - selectedShot.narration.startFrame} 帧</span>
                            <span className="text-stone-500">对应稿件</span><p className="leading-6">{selectedShot.narration.sourceExcerpt}</p>
                            <span className="text-stone-500">画面目标</span><p className="leading-6">{selectedShot.visual}</p>
                            <span className="text-stone-500">镜头构图</span><p className="leading-6">{selectedShot.composition}</p>
                        </div>
                        <div className="mx-auto w-full max-w-5xl py-4"><h2 className="mb-3 text-sm font-semibold">版本记录</h2><div className="flex gap-3 overflow-x-auto pb-2">{selectedShot.versions.map((version) => <VersionItem key={version.id} projectId={project.id} shot={selectedShot} version={version} onSelect={() => void chooseVersion(version.id)} />)}</div></div>
                    </div>
                    <FixedTimeline project={project} selectedShotId={selectedShot.id} onSelect={setSelectedShotId} />
                </section>

                <aside className={`min-h-0 overflow-y-auto border-l border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-[80] max-lg:w-[min(360px,100vw)] max-lg:shadow-2xl ${mobileInspectorOpen ? "max-lg:block" : "max-lg:hidden"}`}>
                    <div className="mb-3 hidden items-center justify-between max-lg:flex"><strong className="text-sm">修改与审核</strong><Button type="text" shape="circle" icon={<X className="size-4" />} onClick={() => setMobileInspectorOpen(false)} /></div>
                    <section className="border-b border-stone-200 pb-5 dark:border-stone-800">
                        <h2 className="mb-3 text-sm font-semibold">修改画面</h2>
                        <Segmented block value={mode} onChange={(value) => setMode(value as RegenerationMode)} options={[{ label: "局部纠错", value: "repair" }, { label: "重新设计", value: "reshoot" }]} />
                        <p className="mt-2 text-xs leading-5 text-stone-500">{mode === "repair" ? "保留当前画面，只修正明确问题。" : "不依赖当前构图，按人物、场景和画风锚点重新拍摄。"}</p>
                        <Input.TextArea className="mt-3" rows={4} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：修正主角发型，保持三人背影、站位、服装、鱼和蔬菜不变" />
                        <div className="mt-3 flex gap-2">
                            <Input value={referenceLabel} onChange={(event) => setReferenceLabel(event.target.value)} placeholder="参考图对应谁，例如：父亲" maxLength={100} />
                            <input ref={generationReferenceInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void uploadGenerationReference(event.target.files?.[0])} />
                            <Button icon={<ImagePlus className="size-4" />} loading={referenceUploading} onClick={() => generationReferenceInputRef.current?.click()}>添加参考图</Button>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-stone-500">参考图只参与 AI 生成，不会直接替换当前画面。请写清人物或对象名称。</p>
                        {activeCustomReferences.length ? <div className="mt-3 grid grid-cols-2 gap-2">{activeCustomReferences.map((reference) => <div key={reference.id} className="relative min-w-0 border border-stone-200 p-1 dark:border-stone-700"><div className="aspect-video overflow-hidden bg-stone-100 dark:bg-stone-800"><img src={storyReviewCustomReferenceImageUrl(project.id, selectedShot.id, reference.id)} alt={`${reference.label}参考图`} className="h-full w-full object-cover" /></div><div className="flex items-center gap-1 px-1 pt-1"><span className="min-w-0 flex-1 truncate text-xs">{reference.label}</span><Tooltip title="从后续生成中移除"><Button type="text" danger size="small" shape="circle" icon={<Trash2 className="size-3.5" />} onClick={() => void removeGenerationReference(reference.id)} /></Tooltip></div></div>)}</div> : null}
                        <div className="mt-3"><ModelPicker config={config} value={model} capability="image" fullWidth onChange={(value) => updateConfig("imageModel", value)} onMissingConfig={() => openConfigDialog(true)} /></div>
                        <Button className="mt-3" block type="primary" icon={generating ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} disabled={generating} onClick={() => void regenerate()}>{generating ? "正在生成候选版本" : "生成新版本"}</Button>
                        <div className="mt-4 border-t border-stone-200 pt-3 dark:border-stone-800"><p className="mb-2 text-xs font-medium">直接替换最终成品</p><input ref={replacementInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void uploadReplacement(event.target.files?.[0])} /><Button block icon={<Upload className="size-4" />} loading={uploading} onClick={() => replacementInputRef.current?.click()}>人工替换图片</Button></div>
                    </section>

                    <section className="border-b border-stone-200 py-5 dark:border-stone-800">
                        <h2 className="mb-1 text-sm font-semibold">本次 API 参考顺序</h2>
                        <p className="mb-3 text-xs leading-5 text-stone-500">模型将严格按下面的编号接收原图、人物参考和系统连续性素材。</p>
                        <div className="grid grid-cols-2 gap-2">{generationReferencePlan.map((reference, index) => <div key={reference.id} className="min-w-0"><div className="aspect-video overflow-hidden bg-stone-100 dark:bg-stone-800"><img loading="lazy" src={generationReferenceImageUrl(project, selectedShot, reference)} alt={reference.label} className="h-full w-full object-cover" /></div><p className="mt-1 truncate text-xs text-stone-500">{index + 1}. {reference.label}</p></div>)}</div>
                        <div className="mt-3 space-y-2">{selectedShot.textLocks.map((lock) => <details key={`${lock.role}:${lock.label}`}><summary className="cursor-pointer text-xs font-medium">{lock.label}</summary><p className="mt-1 text-xs leading-5 text-stone-500">{lock.text}</p></details>)}</div>
                    </section>

                    <section className="border-b border-stone-200 py-5 dark:border-stone-800">
                        <h2 className="mb-3 text-sm font-semibold">审核结论</h2>
                        <Input.TextArea rows={3} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="记录问题或通过理由" />
                        <div className="mt-3 grid grid-cols-2 gap-2"><Button danger icon={<X className="size-4" />} onClick={() => void setStatus("needs_changes")}>待修改</Button><Button type="primary" icon={<Check className="size-4" />} onClick={() => void setStatus("approved")}>通过并下一镜</Button></div>
                    </section>

                    <section className="pt-5">
                        <h2 className="mb-2 text-sm font-semibold">最近导出</h2>
                        {latestExport ? <div className="space-y-2 text-xs"><p className="text-stone-500">{latestExport.id}</p><div className="grid grid-cols-3 gap-1"><Button href={storyReviewExportFileUrl(project.id, latestExport.id, "video")} block size="small" icon={<Download className="size-3" />}>视频</Button><Button href={storyReviewExportFileUrl(project.id, latestExport.id, "audio")} block size="small" icon={<Download className="size-3" />}>配音</Button><Button href={storyReviewExportFileUrl(project.id, latestExport.id, "subtitles")} block size="small" icon={<Download className="size-3" />}>字幕</Button></div><Button block size="small" icon={<FolderOpen className="size-3" />} onClick={() => void revealStoryReviewExport(project.id, latestExport.id)}>打开目录</Button></div> : <p className="text-xs text-stone-500">尚未从审核台导出</p>}
                    </section>
                </aside>
            </section>
        </main>
    );
}

function ShotListItem({ projectId, shot, active, onClick }: { projectId: string; shot: StoryReviewShot; active: boolean; onClick: () => void }) {
    return <button type="button" onClick={onClick} className={`mb-1 grid w-full grid-cols-[88px_minmax(0,1fr)] gap-2 p-2 text-left transition ${active ? "bg-stone-100 dark:bg-stone-800" : "hover:bg-stone-50 dark:hover:bg-stone-800/60"}`}><div className="aspect-video overflow-hidden bg-stone-200 dark:bg-stone-800"><img loading="lazy" src={storyReviewVersionImageUrl(projectId, shot.id, shot.selectedVersionId)} alt="" className="h-full w-full object-cover" /></div><div className="min-w-0"><div className="flex items-center gap-1.5 text-xs"><StatusDot status={shot.reviewStatus} /><strong>{shot.id}</strong>{shot.versions.length > 1 ? <span className="text-blue-600">v{shot.versions.length}</span> : null}<span className="ml-auto text-stone-400">{shot.narration.durationSeconds.toFixed(1)}s</span></div><p className="mt-1 line-clamp-2 text-xs leading-4 text-stone-500">{shot.narration.sourceExcerpt}</p></div></button>;
}

function VersionItem({ projectId, shot, version, onSelect }: { projectId: string; shot: StoryReviewShot; version: StoryReviewShot["versions"][number]; onSelect: () => void }) {
    const selected = version.id === shot.selectedVersionId;
    return <button type="button" onClick={onSelect} className={`w-36 shrink-0 border p-1 text-left ${selected ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30" : "border-stone-200 dark:border-stone-800"}`}><div className="aspect-video overflow-hidden bg-stone-200 dark:bg-stone-800"><img loading="lazy" src={storyReviewVersionImageUrl(projectId, shot.id, version.id)} alt="" className="h-full w-full object-cover" /></div><div className="flex items-center justify-between px-1 pt-1 text-xs"><span>{version.id}</span><span className="text-stone-500">{versionSourceLabel(version.source)}</span></div>{version.note ? <p className="truncate px-1 pt-0.5 text-[11px] text-stone-400">{version.note}</p> : null}</button>;
}

function FixedTimeline({ project, selectedShotId, onSelect }: { project: StoryReviewProject; selectedShotId: string; onSelect: (id: string) => void }) {
    return <div className="h-28 shrink-0 border-t border-stone-200 bg-white px-3 py-2 dark:border-stone-800 dark:bg-stone-900"><div className="mb-2 flex items-center justify-between text-xs"><strong>固定画面时间轴</strong><span className="text-stone-500">选版只换图片，不改时长</span></div><div className="flex h-16 gap-px overflow-x-auto pb-2">{project.shots.map((shot) => <button key={shot.id} type="button" title={`${shot.id} · ${shot.narration.durationSeconds.toFixed(2)} 秒`} onClick={() => onSelect(shot.id)} style={{ width: Math.max(42, Math.min(140, shot.narration.durationSeconds * 9)) }} className={`shrink-0 border-t-2 px-1 text-left text-[10px] transition ${shot.id === selectedShotId ? "border-blue-500 bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100" : shot.reviewStatus === "approved" ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30" : shot.reviewStatus === "needs_changes" ? "border-rose-500 bg-rose-50 dark:bg-rose-950/30" : "border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-800"}`}><span className="block font-medium">{shot.id}</span><span className="text-stone-500">{shot.narration.durationSeconds.toFixed(1)}s</span></button>)}</div></div>;
}

function StatusDot({ status }: { status: StoryReviewStatus }) {
    const className = status === "approved" ? "bg-emerald-500" : status === "needs_changes" ? "bg-rose-500" : "bg-amber-400";
    return <span className={`inline-block size-2 shrink-0 rounded-full ${className}`} />;
}

function buildReferences(project: StoryReviewProject, shot: StoryReviewShot, references: GenerationReferenceDescriptor[]): ReferenceImage[] {
    return references.map((reference, index) => ({
        id: reference.id,
        name: `${index + 1}-${reference.label}.png`,
        type: "image/png",
        dataUrl: generationReferenceImageUrl(project, shot, reference),
    }));
}

function buildReferenceDescriptors(shot: StoryReviewShot, mode: RegenerationMode): GenerationReferenceDescriptor[] {
    const current: GenerationReferenceDescriptor = { id: `shot:${shot.id}`, role: "current", label: "当前待修原图", source: "current" };
    const custom: GenerationReferenceDescriptor[] = shot.customReferences
        .filter((reference) => reference.active)
        .map((reference) => ({ id: `custom:${reference.id}`, role: "identity", label: `用户参考：${reference.label}`, source: "custom", customReferenceId: reference.id }));
    const system: GenerationReferenceDescriptor[] = shot.imageReferences
        .filter((reference) => reference.id !== current.id)
        .map((reference) => ({ ...reference, source: "system" as const }));
    return (mode === "repair" ? [current, ...custom, ...system] : [...custom, ...system]).slice(0, 10);
}

function buildRegenerationPrompt(project: StoryReviewProject, shot: StoryReviewShot, mode: RegenerationMode, instruction: string, references: GenerationReferenceDescriptor[]) {
    const locks = shot.textLocks.map((item) => `${item.label}：${item.text}`).join("\n");
    const referencePlan = references.map((reference, index) => {
        if (reference.source === "current") return `参考图${index + 1}：当前待修原图，是构图、人物数量、站位、动作、服装、道具和背景的唯一底图。`;
        if (reference.source === "custom") return `参考图${index + 1}：${reference.label}，只用于锁定该名称所指人物或对象的身份与外观，不复制其背景、姿势或构图。`;
        return `参考图${index + 1}：${reference.label}，用于统一${reference.role === "style" ? "画风" : reference.role === "scene" ? "场景" : reference.role === "identity" ? "人物身份与年龄状态" : "镜头连续性"}。`;
    }).join("\n");
    const policy = mode === "repair"
        ? "这是局部纠错。以参考图1当前待修原图为唯一画面底图，只修改明确提出的问题；人物数量、其他人物身份、年龄、服装、站位、动作、道具、景别、镜头方向、光线和背景均不得无故变化。用户人物参考只作用于指令点名的对应人物，禁止把同一张脸套给其他角色。"
        : "这是语义重拍。不要沿用当前画面的错误构图；根据用户人物参考、画风母版、场景锚点和相邻镜头重新设计，但必须保持人物身份、年代、服装、场景轴线和道具连续。用户人物参考只锁定同名角色，禁止复制参考图背景或把同一人物套给其他角色。";
    return `横向16:9单幅电影分镜，不要多格拼贴，不要可读文字、Logo或水印。\n\n${policy}\n\n本次参考图顺序：\n${referencePlan || "本次没有图像参考，只按文本生成。"}\n\n镜头：${shot.id} / ${shot.sceneId}\n对应台词：${shot.narration.sourceExcerpt}\n叙事功能：${shot.function}\n画面事实：${shot.visual}\n构图要求：${shot.composition}\n\n本次必须解决：${instruction}\n\n连续性锁：\n${locks}\n\n统一风格：${project.style.description}\n输出一张完成图。`;
}

function generationReferenceImageUrl(project: StoryReviewProject, shot: StoryReviewShot, reference: GenerationReferenceDescriptor) {
    if (reference.source === "current") return storyReviewVersionImageUrl(project.id, shot.id, shot.selectedVersionId);
    if (reference.source === "custom" && reference.customReferenceId) return storyReviewCustomReferenceImageUrl(project.id, shot.id, reference.customReferenceId);
    return storyReviewReferenceImageUrl(project.id, reference.id);
}

async function normalizeTo16x9(source: string) {
    const image = await loadImage(source);
    let sx = 0;
    let sy = 0;
    let sw = image.naturalWidth;
    let sh = image.naturalHeight;
    const targetRatio = 16 / 9;
    if (sw / sh > targetRatio) {
        const nextWidth = Math.round(sh * targetRatio);
        sx = Math.floor((sw - nextWidth) / 2);
        sw = nextWidth;
    } else {
        const nextHeight = Math.round(sw / targetRatio);
        sy = Math.floor((sh - nextHeight) / 2);
        sh = nextHeight;
    }
    const maxWidth = 1920;
    const width = Math.min(maxWidth, sw);
    const height = Math.round(width * 9 / 16);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理替换图片");
    context.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
    return { dataUrl: canvas.toDataURL("image/png"), width, height };
}

async function prepareReferenceImage(source: string) {
    const image = await loadImage(source);
    const maxEdge = 2048;
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理参考图片");
    context.drawImage(image, 0, 0, width, height);
    return { dataUrl: canvas.toDataURL("image/png"), width, height };
}

function loadImage(source: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片读取失败"));
        image.src = source;
    });
}

function fileToDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
    });
}

function formatTime(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}分${Math.round(seconds % 60)}秒`;
}

function formatTimestamp(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

function versionSourceLabel(source: StoryReviewShot["versions"][number]["source"]) {
    return source === "generated" ? "AI" : source === "uploaded" ? "人工" : "初版";
}

function delay(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
