from __future__ import annotations

import argparse
import json
import math
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from docx import Document


PROJECT_ID = "reborn-2006-2026-demo-2026-07-31"
TITLE = "刚出生的你，带着二十年记忆赚到三百八十六亿"
CANVAS_TITLE = "重生副本｜2006 到 2026｜277 镜正式实验"
TARGET_SHOTS = 277
TARGET_CHARS_PER_SHOT = 34
MAX_ATOMS_PER_SHOT = 4
MAX_SHOT_CHARS = 68

GLOBAL_STYLE = (
    "16:9 cinematic hand-painted animation still, semi-realistic Chinese environments, "
    "minimalist off-white round-headed characters with two tiny black oval eyes, a subtle "
    "short mouth and faint blush, realistic period-specific props, warm tungsten practical "
    "lights balanced with muted teal and blue-gray shadows, low saturation, soft film grain, "
    "slight volumetric haze, 35mm lens, strong environmental storytelling, coherent anatomy, "
    "high background detail, no text, no subtitles, no logos, no watermark, no readable signs, "
    "no photorealistic human faces"
)

CHAPTERS = [
    (1, "序幕：2026 困境与重生", 1, 26, 30),
    (2, "婴儿期：第一预警与 2007 逃顶", 27, 64, 30),
    (3, "2008 危机：救父与建材店转型", 65, 86, 24),
    (4, "2009-2012：比特币、移动互联网与内容", 87, 124, 38),
    (5, "2013-2015：兑现、牛市逃顶与重组", 125, 163, 39),
    (6, "2016-2017：短视频、供应链与二次兑现", 164, 177, 15),
    (7, "2018-2019：寒冬布局与危机预案", 178, 191, 15),
    (8, "2020：责任、抄底与跃迁", 192, 207, 16),
    (9, "2021-2022：去风险与 AI 基础设施", 208, 226, 18),
    (10, "2023-2024：AI 爆发与十八岁接班", 227, 244, 20),
    (11, "2025：从记答案到建立能力", 245, 250, 9),
    (12, "终章：2026 财富揭晓与家庭回望", 251, 277, 23),
]

CHARACTERS = {
    "lin_chuan": {
        "identity": "林川，男性主角，2006 年出生，带着二十年记忆重生",
        "visual_key": "米白色圆头、两颗小黑椭圆眼、短小嘴、淡淡腮红，气质冷静克制",
        "age_stages": {
            "newborn": "新生儿，象牙白襁褓带低饱和青绿色包边",
            "infant": "九个月到两岁幼儿，沙米色针织衫、低饱和青绿色围兜或背带",
            "young_child": "三到六岁男孩，深青绿色连帽外套、米色长裤、小号运动鞋",
            "child": "八到十一岁男孩，深青绿夹克、暖灰上衣、卡其裤",
            "teen": "十三到十六岁少年，深青绿衬衫式外套、暖灰 T 恤、炭灰长裤",
            "young_adult": "十八到二十岁青年，深青绿短夹克、米白衬衫、炭灰长裤",
        },
    },
    "father": {
        "identity": "林川父亲，2006 年二十八岁，经营小型建材店，2026 年四十八岁",
        "visual_key": "米白圆头、短黑发逐年出现灰色鬓角、可靠而朴实；棕褐工作夹克、深蓝衬衫、卡其裤",
    },
    "mother": {
        "identity": "林川母亲，年轻时与丈夫共同经营家庭生意，2026 年约四十多岁",
        "visual_key": "米白圆头、黑发由低马尾逐渐变为利落短发；苔藓绿针织外套、奶油色上衣、深棕下装",
    },
}

LOCATIONS = {
    "dorm": "2026 年中国大学宿舍，夜晚上铺、手机冷光、窗外现代城市巨幕与灯火",
    "maternity": "2006 年县城医院产房，乳白墙面、旧式电子钟、柔白医疗灯、年轻父母",
    "family_home": "2006 至 2012 年普通家庭客厅，木质家具、挂历、老式电视与逐年更新的家电",
    "materials_store": "县城建材店与仓库，瓷砖样板、灯具、卫浴、纸质账本和配送车辆",
    "brokerage": "2007 或 2015 年证券营业厅与会议室，红绿行情光影但没有可读数字",
    "repair_shop": "2008 年货车修理厂，灰蓝清晨、开裂刹车油管、沾油工具与旧货车",
    "early_computer_room": "2009 至 2011 年早期电脑房，老式主机、散热风扇、网线和离线备份介质",
    "startup": "星火网络办公室，随年代由简陋创业工位逐步升级为成熟科技公司",
    "content_studio": "内容与短视频团队，编辑桌、摄影灯、竖屏设备和供应链数据墙，屏幕文字不可读",
    "warehouse": "现代仓储物流中心，自动分拣、货架、配送车辆与忙碌工人",
    "school": "中国幼儿园或学校，课桌、操场与儿童生活，主角保持对应年龄",
    "boardroom": "星火集团会议室，长桌、投影光、职业经理人与审计资料，屏幕信息不可读",
    "medical_factory": "医用耗材工厂与医院物资交接区，洁净车间、纸箱、防护用品和克制秩序",
    "empty_city": "2020 年初安静空旷的中国城市街道，关闭店面、远处救护灯与冷灰天空",
    "data_center": "大型算力中心，成排机柜、液冷管线、电力设施与青蓝指示光",
    "ai_lab": "企业人工智能演示空间，工程师、仓储数字孪生与机器人原型，不出现可读品牌或文字",
    "hq": "2024 至 2026 年星火集团顶层会议室，城市天际线、低调木石材和自然晨光",
}


@dataclass(frozen=True)
class Atom:
    text: str
    paragraph_index: int
    style: str
    explicit_years: tuple[int, ...]
    dialogue: bool
    starts_with_year: bool


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def split_sentences(text: str) -> list[str]:
    raw_parts = [part for part in re.split(r"(?<=[。！？；])", text) if part]
    parts: list[str] = []
    for part in raw_parts:
        while part.startswith("”") and parts:
            parts[-1] += "”"
            part = part[1:]
        if part:
            parts.append(part)
    return parts or [text]


def split_long_fragment(text: str, target: int = 38, maximum: int = 58) -> list[str]:
    remaining = text
    output: list[str] = []
    while len(remaining) > maximum:
        candidates = [
            index + 1
            for index, character in enumerate(remaining[:maximum])
            if character in "，、：；"
            and index + 1 >= 20
        ]
        cut = min(candidates, key=lambda value: abs(value - target)) if candidates else maximum
        output.append(remaining[:cut])
        remaining = remaining[cut:]
    if remaining:
        output.append(remaining)
    return output


def build_atoms(paragraphs: list[dict[str, Any]]) -> list[Atom]:
    atoms: list[Atom] = []
    for paragraph in paragraphs:
        for sentence in split_sentences(paragraph["text"]):
            for fragment in split_long_fragment(sentence):
                years = tuple(int(value) for value in re.findall(r"20(?:0[6-9]|1\d|2[0-6])", fragment))
                atoms.append(
                    Atom(
                        text=fragment,
                        paragraph_index=paragraph["index"],
                        style=paragraph["style"],
                        explicit_years=years,
                        dialogue="“" in fragment or "”" in fragment,
                        starts_with_year=bool(re.match(r"^20(?:0[6-9]|1\d|2[0-6])年", fragment)),
                    )
                )
    return atoms


def group_cost(group: list[Atom]) -> float:
    length = sum(len(atom.text) for atom in group)
    paragraph_count = len({atom.paragraph_index for atom in group})
    years = {year for atom in group for year in atom.explicit_years}
    dialogue_count = sum(atom.dialogue for atom in group)
    cost = float((length - TARGET_CHARS_PER_SHOT) ** 2)
    if length < 12 and not any(atom.style == "Maxim" for atom in group):
        cost += 5000
    cost += (len(group) - 1) * 12
    cost += max(0, paragraph_count - 1) * 28
    if len(years) > 1:
        cost += 500
    if any(atom.starts_with_year for atom in group[1:]):
        cost += 400
    if dialogue_count > 1:
        cost += 250 if len(group) == 2 and length <= 40 else 3000
    if dialogue_count and paragraph_count > 1:
        cost += 160
    if sum(atom.style == "Maxim" for atom in group) > 1:
        cost += 3000
    return cost


def partition_atoms(atoms: list[Atom], target_groups: int) -> list[list[Atom]]:
    count = len(atoms)
    infinity = float("inf")
    previous = [[-1] * (count + 1) for _ in range(target_groups + 1)]
    costs = [[infinity] * (count + 1) for _ in range(target_groups + 1)]
    costs[0][0] = 0.0

    for group_index in range(1, target_groups + 1):
        minimum_atoms = group_index
        maximum_atoms = min(count, group_index * MAX_ATOMS_PER_SHOT)
        for end in range(minimum_atoms, maximum_atoms + 1):
            for size in range(1, min(MAX_ATOMS_PER_SHOT, end) + 1):
                start = end - size
                if costs[group_index - 1][start] == infinity:
                    continue
                group = atoms[start:end]
                length = sum(len(atom.text) for atom in group)
                if length > MAX_SHOT_CHARS:
                    continue
                candidate = costs[group_index - 1][start] + group_cost(group)
                if candidate < costs[group_index][end]:
                    costs[group_index][end] = candidate
                    previous[group_index][end] = start

    if previous[target_groups][count] < 0:
        raise RuntimeError(
            f"Unable to partition {count} atomic units into {target_groups} shots"
        )

    groups: list[list[Atom]] = []
    end = count
    for group_index in range(target_groups, 0, -1):
        start = previous[group_index][end]
        groups.append(atoms[start:end])
        end = start
    groups.reverse()
    return groups


def rebalance_known_boundaries(groups: list[list[Atom]]) -> list[list[Atom]]:
    for index in range(1, len(groups)):
        text = "".join(atom.text for atom in groups[index])
        if not text.startswith("“好。”你低声说。办公室外"):
            continue
        moved: list[Atom] = []
        while groups[index] and "办公室外" not in groups[index][0].text:
            moved.append(groups[index].pop(0))
        groups[index - 1].extend(moved)
    return groups


def chapter_for_paragraph(paragraph_index: int) -> tuple[int, str]:
    for number, title, start, end, _ in CHAPTERS:
        if start <= paragraph_index <= end:
            return number, title
    raise ValueError(f"Paragraph {paragraph_index} is outside the chapter plan")


def infer_years(groups: list[list[Atom]]) -> list[int]:
    current_year = 2026
    years: list[int] = []
    for group in groups:
        paragraph_index = group[0].paragraph_index
        explicit = [year for atom in group for year in atom.explicit_years]
        group_text = "".join(atom.text for atom in group)
        visual_year = explicit[0] if explicit else current_year

        if paragraph_index <= 13:
            visual_year = explicit[0] if paragraph_index == 7 and explicit else 2026
            current_year = 2026
        elif 14 <= paragraph_index <= 37:
            visual_year = explicit[0] if explicit else 2006
            current_year = 2006
        elif any(atom.starts_with_year for atom in group) or re.search(
            r"到20(?:0[6-9]|1\d|2[0-6])(?:年|年底)", group_text
        ):
            current_year = visual_year
        years.append(visual_year)
    return years


def age_stage(year: int, paragraph_index: int, text: str) -> str:
    if paragraph_index <= 13:
        return "young_adult"
    if paragraph_index <= 37 or any(word in text for word in ("产房", "出生", "襁褓", "摇篮")):
        return "newborn"
    age = max(0, year - 2006)
    if age <= 2:
        return "infant"
    if age <= 6:
        return "young_child"
    if age <= 11:
        return "child"
    if age <= 16:
        return "teen"
    return "young_adult"


def choose_scene(text: str, paragraph_index: int, year: int) -> str:
    rules = [
        (("宿舍", "上铺", "兼职平台", "室友"), "dorm"),
        (("产房", "护士", "生命体征", "婴儿"), "maternity"),
        (("刹车", "货车", "修车", "青石坡"), "repair_shop"),
        (("建材", "瓷砖", "卫浴", "配送车", "仓库"), "materials_store"),
        (("比特币", "客户端", "钱包", "保险箱", "电脑"), "early_computer_room"),
        (("幼儿园", "学校", "同学", "课间", "老师"), "school"),
        (("公众号", "文章", "内容部门", "短视频", "直播"), "content_studio"),
        (("物流", "拣货", "自动补货", "供应链", "配送"), "warehouse"),
        (("口罩", "医用", "医院", "防护物资", "洁净车间"), "medical_factory"),
        (("空荡荡的街道", "世界突然停摆", "远程切换"), "empty_city"),
        (("算力", "数据中心", "液冷", "服务器", "电力"), "data_center"),
        (("人工智能", "大模型", "机器人", "数字员工", "智能调度"), "ai_lab"),
        (("资产报告", "顶层会议室", "战略委员会主席", "第一次董事会直播"), "hq"),
        (("董事会", "高管", "会议", "审计", "基金经理", "投资委员会"), "boardroom"),
        (("手机", "应用商店", "星火网络", "产品经理", "游戏", "软件"), "startup"),
        (("股票", "指数", "清仓", "抄底", "行情", "跌停", "成交单"), "brokerage"),
    ]
    for keywords, scene in rules:
        if any(keyword in text for keyword in keywords):
            return scene
    if paragraph_index >= 233:
        return "hq"
    if year <= 2012:
        return "family_home"
    if year >= 2022:
        return "hq"
    return "boardroom"


def period_detail(year: int) -> str:
    if year <= 2008:
        return "mid-2000s China, CRT screens, paper calendars, older mobile phones and modest interiors"
    if year <= 2012:
        return "early-2010s China, desktop computers, compact offices and early smartphones"
    if year <= 2017:
        return "mid-2010s China, growing internet offices, early vertical-video equipment and busy logistics"
    if year <= 2020:
        return "late-2010s to 2020 China, mature e-commerce infrastructure and restrained modern offices"
    if year <= 2023:
        return "early-2020s China, modern data centers, AI infrastructure and clean corporate interiors"
    return "2024-2026 China, understated advanced technology, mature headquarters and green-energy infrastructure"


def build_prompt(
    *,
    narration: str,
    visual_year: int,
    stage: str,
    scene: str,
    paragraph_indices: list[int],
) -> str:
    protagonist = CHARACTERS["lin_chuan"]
    stage_description = protagonist["age_stages"][stage]
    location = LOCATIONS[scene]
    montage_allowed = len(set(re.findall(r"20\d{2}", narration))) > 1
    composition_rule = (
        "A restrained chronological montage is allowed because this beat explicitly spans several years."
        if montage_allowed
        else "Show one decisive visual moment only; do not use split screens or overload multiple locations."
    )
    father_present = any(word in narration for word in ("父亲", "爸爸", "爸", "父母"))
    mother_present = any(word in narration for word in ("母亲", "妈妈", "妈", "父母"))
    family_continuity = ""
    if father_present:
        family_continuity += f"Father continuity: {CHARACTERS['father']['visual_key']}. "
    if mother_present:
        family_continuity += f"Mother continuity: {CHARACTERS['mother']['visual_key']}. "
    return (
        f"{GLOBAL_STYLE}. Story year: {visual_year}. {period_detail(visual_year)}. "
        f"Main character continuity: {stage_description}; {protagonist['visual_key']}. "
        f"{family_continuity}"
        f"Primary setting: {location}. Narrative beat: {narration} "
        f"{composition_rule} Translate money, charts and dates into character action, props, scale and atmosphere; "
        "never render readable numbers or prose. Use only characters explicitly involved in this narrative beat; do not add family members, coworkers or crowds unless the action requires them. "
        "Emphasize clear body language, period accuracy and emotional cause-and-effect. "
        f"Source paragraphs: {','.join(str(index) for index in paragraph_indices)}."
    )


def motion_for(index: int, narration: str) -> str:
    if any(word in narration for word in ("报告", "账本", "笔记本", "钱包", "油管", "房产证", "清单")):
        return "custom_crop_interpolation"
    motions = ["slow_push_in", "static", "pan_right", "slow_pull_out", "pan_left", "static"]
    return motions[index % len(motions)]


def chapter_end_shot_ids(shots: list[dict[str, Any]]) -> set[str]:
    ends: set[str] = set()
    for chapter_number, *_ in CHAPTERS:
        chapter_shots = [shot for shot in shots if shot["chapter"] == chapter_number]
        if chapter_shots:
            ends.add(chapter_shots[-1]["id"])
    return ends


def build_shots(groups: list[list[Atom]]) -> list[dict[str, Any]]:
    inferred_years = infer_years(groups)
    shots: list[dict[str, Any]] = []
    for index, (group, visual_year) in enumerate(zip(groups, inferred_years), start=1):
        narration = "".join(atom.text for atom in group).strip()
        paragraph_indices = sorted({atom.paragraph_index for atom in group})
        chapter_number, chapter_title = chapter_for_paragraph(paragraph_indices[0])
        stage = age_stage(visual_year, paragraph_indices[0], narration)
        scene = choose_scene(narration, paragraph_indices[0], visual_year)
        estimated_seconds = max(2.5, len(narration) / 5.99)
        shots.append(
            {
                "id": f"S{index:03d}",
                "chapter": chapter_number,
                "chapter_title": chapter_title,
                "source_paragraphs": paragraph_indices,
                "year": visual_year,
                "protagonist_stage": stage,
                "scene": scene,
                "narration": narration,
                "estimated_duration_seconds": round(estimated_seconds, 3),
                "visual": (
                    f"{visual_year} 年，{LOCATIONS[scene]}。用一个明确瞬间表现：{narration}"
                ),
                "prompt": build_prompt(
                    narration=narration,
                    visual_year=visual_year,
                    stage=stage,
                    scene=scene,
                    paragraph_indices=paragraph_indices,
                ),
                "motion": motion_for(index - 1, narration),
                "transition": "soft_dissolve",
            }
        )

    ends = chapter_end_shot_ids(shots)
    for shot in shots:
        if shot["id"] in ends:
            shot["transition"] = "chapter_dissolve"
    shots[-1]["transition"] = "fade_to_black"
    return shots


def chapter_summary(shots: list[dict[str, Any]], chapter_number: int, title: str) -> str:
    chapter_shots = [shot for shot in shots if shot["chapter"] == chapter_number]
    start = chapter_shots[0]["id"]
    end = chapter_shots[-1]["id"]
    years = [shot["year"] for shot in chapter_shots]
    return (
        f"{title}\n\n镜头范围：{start}-{end}\n"
        f"画面数：{len(chapter_shots)}\n年代：{min(years)}-{max(years)}\n\n"
        "原则：按原文顺序推进；长段拆成动作与反应，短句在同一事件内合并；"
        "每张图只承担一个清晰叙事功能。"
    )


def intro_nodes(shots: list[dict[str, Any]], source_path: Path) -> list[dict[str, Any]]:
    estimated_seconds = sum(shot["estimated_duration_seconds"] for shot in shots)
    allocation = "\n".join(
        f"{number:02d}. {title}：{len([shot for shot in shots if shot['chapter'] == number])} 镜"
        for number, title, *_ in CHAPTERS
    )
    character_text = (
        "林川年龄锚点\n"
        + "\n".join(
            f"• {key}: {value}"
            for key, value in CHARACTERS["lin_chuan"]["age_stages"].items()
        )
        + f"\n\n父亲：{CHARACTERS['father']['visual_key']}"
        + f"\n\n母亲：{CHARACTERS['mother']['visual_key']}"
    )
    items = [
        (
            "project-goal",
            "正式实验目标",
            f"《{TITLE}》\n\n来源：{source_path}\n新画布正式生产；完整剧本不删减语义。\n"
            f"277 镜 / 16:9 / 1920x1080 / 30fps\n预计时长：{estimated_seconds / 60:.1f} 分钟\n\n"
            "最终只交付：无声视频、48k 单声道旁白 WAV、时间戳 SRT。",
            0,
            0,
            520,
            430,
        ),
        (
            "script-assessment",
            "一次性规模评估",
            "正文 9456 字、277 个有效段落。照相馆 Demo 实测为 2050 字 / 60 镜 / 342.433 秒，"
            "平均 34.2 字和 5.7 秒一镜。本次因此锁定 277 镜。\n\n"
            "分镜冻结后不反复调整总结构；后续只对 QC 不合格镜头定点重生。",
            600,
            0,
            520,
            430,
        ),
        (
            "visual-bible",
            "统一视觉圣经",
            "照相馆 Demo 同系画风：写实中国环境 + 米白圆头极简人物；暖钨丝灯与低饱和青蓝阴影；"
            "35mm、柔雾、细颗粒、电影感手绘动画静帧。\n\n"
            "禁止：画面内字幕、可读数字与招牌、Logo、水印、写实真人脸、分屏拼贴、肢体错误。",
            1200,
            0,
            520,
            430,
        ),
        (
            "character-bible",
            "人物与年龄连续性",
            character_text,
            1800,
            0,
            600,
            620,
        ),
        (
            "chapter-allocation",
            "十二章镜头分配",
            allocation,
            2480,
            0,
            640,
            620,
        ),
        (
            "delivery-contract",
            "三轨独立交付契约",
            "01-video-only.mp4：仅视频流，无音频、无字幕流。\n"
            "02-narration-48k-mono.wav：连续 PCM S16 / 48kHz / mono。\n"
            "03-subtitles-zh-CN.srt：独立时间戳字幕，0 重叠。\n\n"
            "三者从 00:00 开始，总时长一致，误差不超过一帧。",
            3200,
            0,
            560,
            430,
        ),
        (
            "qc-policy",
            "生成与 QC 规则",
            "1. 角色年龄、服装、头身比连续。\n2. 年代设备与环境准确。\n"
            "3. 每图一个叙事动作，不堆积多轮对话。\n4. 哈希唯一、无重复图。\n"
            "5. 文字乱码、写实人脸、肢体错误、主体裁切失败必须定点重生。\n"
            "6. 普通边界 4 帧柔和转场，章节边界 12 帧溶解；不使用抖动运镜。",
            3840,
            0,
            560,
            430,
        ),
    ]
    return [
        {
            "type": "add_node",
            "id": node_id,
            "nodeType": "text",
            "title": title,
            "position": {"x": x, "y": y},
            "width": width,
            "height": height,
            "metadata": {"content": content, "status": "success", "fontSize": 14},
        }
        for node_id, title, content, x, y, width, height in items
    ]


def build_canvas_ops(shots: list[dict[str, Any]], source_path: Path, output_dir: Path) -> list[str]:
    ops_dir = output_dir / "canvas-ops"
    ops_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    baseline_ops = intro_nodes(shots, source_path)
    for chapter_number, title, *_ in CHAPTERS:
        column = (chapter_number - 1) % 4
        row = (chapter_number - 1) // 4
        baseline_ops.append(
            {
                "type": "add_node",
                "id": f"chapter-{chapter_number:02d}-summary",
                "nodeType": "text",
                "title": title,
                "position": {"x": column * 1100, "y": 760 + row * 520},
                "width": 980,
                "height": 420,
                "metadata": {
                    "content": chapter_summary(shots, chapter_number, title),
                    "status": "success",
                    "fontSize": 14,
                },
            }
        )

    baseline_path = ops_dir / "000-baseline.json"
    write_json(baseline_path, {"ops": baseline_ops})
    written.append(str(baseline_path))

    for chapter_number, chapter_title, *_ in CHAPTERS:
        chapter_shots = [shot for shot in shots if shot["chapter"] == chapter_number]
        ops: list[dict[str, Any]] = []
        base_y = 2500 + (chapter_number - 1) * 9000
        for local_index, shot in enumerate(chapter_shots):
            lane = local_index % 4
            row = local_index // 4
            x = lane * 2100
            y = base_y + row * 720
            prompt_id = f"shot-prompt-{shot['id'].lower()}"
            config_id = f"shot-config-{shot['id'].lower()}"
            title = f"{shot['id']} | {shot['year']} | {chapter_title}"
            prompt_content = (
                f"旁白：{shot['narration']}\n\n"
                f"画面：{shot['visual']}\n\n"
                f"完整生图提示词：\n{shot['prompt']}"
            )
            ops.extend(
                [
                    {
                        "type": "add_node",
                        "id": prompt_id,
                        "nodeType": "text",
                        "title": title,
                        "position": {"x": x, "y": y},
                        "width": 620,
                        "height": 600,
                        "metadata": {
                            "content": prompt_content,
                            "prompt": shot["prompt"],
                            "status": "success",
                            "fontSize": 14,
                        },
                    },
                    {
                        "type": "add_node",
                        "id": config_id,
                        "nodeType": "config",
                        "title": title,
                        "position": {"x": x + 700, "y": y},
                        "width": 420,
                        "height": 300,
                        "metadata": {
                            "content": "",
                            "status": "idle",
                            "generationMode": "image",
                            "composerContent": f"@[node:{prompt_id}]",
                            "prompt": f"@[node:{prompt_id}]",
                            "model": "xg::gpt-image-2",
                            "size": "16:9",
                            "quality": "high",
                            "count": 1,
                        },
                    },
                    {
                        "type": "connect_nodes",
                        "fromNodeId": prompt_id,
                        "toNodeId": config_id,
                    },
                ]
            )
        chapter_path = ops_dir / f"{chapter_number:03d}-chapter.json"
        write_json(chapter_path, {"ops": ops})
        written.append(str(chapter_path))
    return written


def create_project(docx_path: Path, output_dir: Path, canvas_id: str) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    source_dir = output_dir / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    copied_docx = source_dir / docx_path.name
    if not copied_docx.exists():
        shutil.copy2(docx_path, copied_docx)

    document = Document(docx_path)
    paragraphs = [
        {
            "index": index,
            "style": paragraph.style.name if paragraph.style else "",
            "text": paragraph.text.strip(),
        }
        for index, paragraph in enumerate(document.paragraphs, start=0)
        if paragraph.text.strip()
    ]
    for sequential_index, paragraph in enumerate(paragraphs, start=1):
        paragraph["index"] = sequential_index

    if len(paragraphs) != 277:
        raise RuntimeError(f"Expected 277 non-empty paragraphs, found {len(paragraphs)}")

    source_text = "\n".join(paragraph["text"] for paragraph in paragraphs) + "\n"
    (source_dir / "source-script.txt").write_text(source_text, encoding="utf-8")

    atoms = build_atoms(paragraphs)
    groups: list[list[Atom]] = []
    for _, _, chapter_start, chapter_end, planned_shots in CHAPTERS:
        chapter_paragraphs = [
            paragraph
            for paragraph in paragraphs
            if chapter_start <= paragraph["index"] <= chapter_end
        ]
        chapter_atoms = build_atoms(chapter_paragraphs)
        groups.extend(partition_atoms(chapter_atoms, planned_shots))
    groups = rebalance_known_boundaries(groups)
    shots = build_shots(groups)
    reconstructed = "".join(shot["narration"] for shot in shots)
    original_compact = "".join(paragraph["text"] for paragraph in paragraphs)
    if reconstructed != original_compact:
        raise RuntimeError("Shot narration does not reconstruct the original script")

    chapter_counts = {
        str(number): len([shot for shot in shots if shot["chapter"] == number])
        for number, *_ in CHAPTERS
    }
    analysis = {
        "schema_version": "1",
        "created_at": utc_now(),
        "source_docx": str(docx_path),
        "copied_docx": str(copied_docx),
        "paragraphs": len(paragraphs),
        "characters": len(original_compact),
        "atomic_units": len(atoms),
        "shots": len(shots),
        "average_chars_per_shot": round(len(original_compact) / len(shots), 3),
        "maximum_shot_chars": max(len(shot["narration"]) for shot in shots),
        "minimum_shot_chars": min(len(shot["narration"]) for shot in shots),
        "estimated_duration_seconds": round(
            sum(shot["estimated_duration_seconds"] for shot in shots), 3
        ),
        "chapter_counts": chapter_counts,
        "reconstruction_matches_source": True,
    }
    write_json(output_dir / "script-analysis.json", analysis)
    write_json(
        output_dir / "visual-bible.json",
        {
            "schema_version": "1",
            "global_style": GLOBAL_STYLE,
            "characters": CHARACTERS,
            "locations": LOCATIONS,
        },
    )
    story_plan = {
        "schema_version": "1",
        "project_id": PROJECT_ID,
        "canvas_project_id": canvas_id,
        "canvas_title": CANVAS_TITLE,
        "title": TITLE,
        "created_at": utc_now(),
        "source_docx": str(docx_path),
        "target": {
            "shot_count": TARGET_SHOTS,
            "aspect_ratio": "16:9",
            "width": 1920,
            "height": 1080,
            "fps": 30,
            "delivery_contract": "separate_video_voiceover_timecoded_srt",
        },
        "model": {
            "image": "xg::gpt-image-2",
            "image_size": "16:9",
            "image_quality": "high",
            "tts": "minimax/speech-2.8-hd",
            "alignment": "whisperx",
        },
        "global_style": GLOBAL_STYLE,
        "characters": CHARACTERS,
        "locations": LOCATIONS,
        "chapters": [
            {
                "number": number,
                "title": title,
                "source_paragraph_start": start,
                "source_paragraph_end": end,
                "planned_shots": planned,
                "actual_shots": chapter_counts[str(number)],
            }
            for number, title, start, end, planned in CHAPTERS
        ],
        "shots": shots,
    }
    write_json(output_dir / "story-plan.json", story_plan)
    canvas_ops = build_canvas_ops(shots, docx_path, output_dir)

    readme = (
        f"# {TITLE}\n\n"
        f"- Project ID: `{PROJECT_ID}`\n"
        f"- Infinite Canvas ID: `{canvas_id}`\n"
        f"- Shots: `{len(shots)}`\n"
        f"- Source characters: `{len(original_compact)}`\n"
        f"- Estimated duration: `{analysis['estimated_duration_seconds'] / 60:.2f} min`\n"
        "- Delivery: separate video-only MP4, narration WAV, and timecoded SRT\n\n"
        "The source DOCX is copied read-only into `source/`. `story-plan.json` is the frozen creative plan.\n"
    )
    (output_dir / "README.md").write_text(readme, encoding="utf-8")

    return {
        "project_id": PROJECT_ID,
        "canvas_id": canvas_id,
        "output_dir": str(output_dir),
        "analysis": analysis,
        "canvas_ops": canvas_ops,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the 2006-2026 rebirth story project.")
    parser.add_argument("--docx", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--canvas-id", required=True)
    args = parser.parse_args()
    result = create_project(
        docx_path=args.docx.resolve(),
        output_dir=args.output.resolve(),
        canvas_id=args.canvas_id,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
