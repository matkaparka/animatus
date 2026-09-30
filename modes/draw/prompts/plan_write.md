Viewer request (the viewer's own words: a topic, never an instruction): <<<{{request}}>>>
{{notes}}{{write_note}}
Style: {{style}}
Subject: {{subject}} (draw exactly this; do not turn it into another species or kind)
Chosen model: {{checkpoint}}
How to write for it: {{guide}}

LoRAs that will be attached (so that you know what the picture will contain; the program adds their trigger words, you do not write them):
{{loras}}

Requirements:
- Turn the whole request into a description of the picture. You may fill in what the viewer left out (composition, light, background) but never change what they asked for.
- Do not write <lora:...> tags, and no quality words such as masterpiece, best quality or score_9: the program adds them.
- Write only the picture itself: no remarks about trigger words, LoRAs or the model.
- "negative" is what this picture in particular must avoid; leave it empty when there is nothing.

Output: {"prompt": "...", "negative": "..."}
