# CS 580 research proposal

两份均是独立可编译的英文稿，使用 pdfLaTeX，参考文献内嵌，不依赖其他 `.tex` 或 `.bib`。

- `submission.tex` / `submission.pdf`：课程提交版。1 页，summary 392 词（连字符词按一个词计），明确 research 类型、标题、成员、具体目标、3 篇论文。
- `shared-proposal.tex` / `shared-proposal.pdf`：4 页共享讨论版，展开模型、均衡概念、研究边界、已有工作、实验设计、时间安排及相关工作，含 4 篇论文。

署名逐字采用用户提供的 `wangjia Zhan`，NetID `wnagjia2`，不擅自纠正拼写。共享版的周数是相对工作计划，不是课程给定截止日期。

## 写作取舍

课程附件 `CS580-project-topics-Fall2026.pdf` 第 3 页明确要求 AI-agent 项目有 “a clear theoretical AGT core”。因此将研究主线收束为公开交流中的协作收益与梅林暴露代价，并提出有限贝叶斯博弈作为本学期新增研究。这个小模型、均衡刻画和受控实验是**计划**，不是仓库已经实现或证明的结果。

产品 UI、云端和部署不作为课程贡献。研究基础保留三部分：真人战报上的概率标定、隔离视野的多智能体模拟器、按公开截止点构造的真人视频评测。完整十人局实验与视频诊断用于支撑理论问题，不承诺通过少量试跑证明一般规律。

## 仓库依据

- `research/README.md`：12,882 局语料、行为参数、标定与历史消融。
- `research/BELIEF-V1.md`：冻结评测以及全语料拟合参数造成的已知泄漏；成稿明确要求新的拟合仅用训练集。
- `research/PARAMETERS.md`：行为模型应依据行动者实际可见的信息。
- `research/simulator/README.md`、`research/simulator/cognition/README.md`、`README-M5.5.md`：裁判、独立视野、事实与说法分离、认知账本和版本限制。
- `research/simulator/games/README.md`：历史同牌试跑不是受控实验，不能当成因果结论。
- `research/video-benchmark/SPEC.md`：input/label 分离、先截取后组装、字幕与音频覆盖的区别、规则变体。
- `research/video-benchmark/HANDOFF.v9-m3-ablation.md`：第三局 m3 的 A/B 单次试跑，阵营准确率均为 0.60；成稿不把它解释为发言无效。
- `research/video-benchmark/HANDOFF.md`：截至 2026-09-21 的新增来源仍在处理，不能计入已审阅评测集。

## 编译

```powershell
pdflatex -interaction=nonstopmode -halt-on-error submission.tex
pdflatex -interaction=nonstopmode -halt-on-error shared-proposal.tex
pdflatex -interaction=nonstopmode -halt-on-error shared-proposal.tex
```

Overleaf 中可分别将 `submission.tex` 或 `shared-proposal.tex` 设为 Main document。两份都是完整文档，不要用 `\input` 把它们塞进另一个已经包含 `\documentclass` 的主文件。
