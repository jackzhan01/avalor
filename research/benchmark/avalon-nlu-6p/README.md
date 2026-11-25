# Avalon-NLU 六人局

来源：Stepputtis et al., *Long-Horizon Dialogue Understanding for Role Identification in the Game of Avalon with Large Language Models*, Findings of EMNLP 2023。原始数据以 MIT 许可发布，许可证原文见 [LICENSE](LICENSE)。使用本子集请引用原论文。

- 20 局，固定板子：梅林、派西维尔、莫甘娜、刺客、两名忠臣（servant）。
- `inputs/<局>/input.en.txt`：整局公开记录（英文聊天 + 点车、票型、任务结果），截在刺杀及终局提示之前；`instruction.en.txt` 是全桌任务的指令。
- `labels/<局>/label.json`：每个座位的真实身份，两名忠臣统一为 `servant`。
- 原数据中的玩家自填 beliefs、说服/欺骗标注都不进入输入。
- 按轮切出的截止点在 `../tasks/tasks.jsonl`（`dataset = avalon-nlu-6p`）。
