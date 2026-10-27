# Reasoning and Cooperation in Avalon

Research Progress Report

We study whether AI can infer hidden roles and make effective team decisions in Avalon, a social deduction game in which good and evil players share public discussion but have different private information. Our work progressed from mathematical inference to LLM agents and evaluation on human games.

## 1. Mathematical inference from game actions

Drawing on CSP4SDG [1] and GRAIL [2], we built a model that tracks possible role assignments, rules out contradictions, and updates probabilities from team choices, votes, and mission outcomes. Across 12,882 human game logs, rule-based elimination never removed the true evil-player combination. We tested individual evidence sources, role-specific knowledge, correlated votes, and simulated future decisions. Better prediction of human team choices did not consistently improve simulated wins. Some behavioral parameters were fitted on the full dataset, so reported predictive results still need evaluation without that leakage. These logs also contain no discussion.

## 2. Combining mathematics with language models

We compared mathematical inference with direct LLM judgments and tested a hybrid that lets the LLM suggest teams while the mathematical model ranks them. The hybrid produced promising candidate teams, but this did not establish better game outcomes. Memory experiments showed that carrying forward the LLM's own notes could reinforce mistakes, while supplying mathematical probabilities helped. Simulated discussion exposed another problem: agents often suspected the same innocent player, even without seeing one another's statements. Correcting for correlated evidence did not make these language-based belief estimates outperform the silent baseline in our tests.

## 3. Letting LLMs play ten-player games

We then ran ten separate LLM players, each restricted to its own information. We tested strategy prompts, memory, fact-versus-claim tracking, and separation of private reasoning from public speech. Agents still accepted unsupported claims, repeated mistaken suspicions, coordinated poorly, and sometimes disclosed private information. Three early archived games all ended in 3-0 evil victories, but reused the same deal and were not independent trials. Later runs showed improvements, including a good-team win; reliable performance across many deals remains untested.

## 4. Evaluating reasoning on human games

To separate understanding a game from playing one, we converted four human game videos into public histories with hidden role labels stored separately. We tested gpt-6-astra once on each of three games: good/evil classification accuracy was 20%, 80%, and 100%; exact-role accuracy was 10%, 30%, and 40%. Different evidence lengths and errors in the first input prevent interpreting this as an improvement trend. In a matched comparison at the third mission of one game, inputs with and without speech both achieved 60% faction accuracy, matching an all-good baseline. One run per condition cannot establish whether speech helps.

## Conclusion and next step

Our results support mathematical inference as a useful foundation, but do not yet demonstrate reliable LLM gameplay or a consistent benefit from discussion. We will prioritize more human games, matched observation cutoffs, repeated speech/no-speech comparisons, and strict separation of training and test data before claiming broader gains.

## References

[1] CSP4SDG: Constraint and Information-Theory Based Role Identification in Social Deduction Games with LLM-Enhanced Inference. arXiv:2511.06175. https://arxiv.org/abs/2511.06175

[2] GRAIL: Bayesian Social Deduction with Graph-Informed Language Models. arXiv:2506.17788. https://arxiv.org/abs/2506.17788
