"""The reasons a viewer (through the model) is given when a request does not work out.

They are the defaults documented in docs/mode-sing.md, in the language the chat commands are written in. Each has a
stable `code`; the operator can replace any text under `messages:` in the settings file. `{name}` fields are
filled in; a field a text does not use is ignored and a field the service did not provide is left empty.

What a viewer is told never carries a path, an address or a tool's output: those are for the operator, in the
service's log and the entry's `error`.
"""

from __future__ import annotations

DEFAULT_MESSAGES: dict[str, str] = {
    'empty_keyword': '没说要点什么歌',
    'blacklisted': '这首歌不能点（黑名单）',
    'per_user_limit': '你点的《{title}》还没唱，一个人同时只能点 {max} 首',
    'queue_full': '点歌队列满了（{max} 首），等会儿再点',
    'not_found': '没搜到「{keyword}」',
    'already_queued': '《{title}》已经在队列里了',
    'playing_now': '《{title}》正在唱',
    'cooldown': '《{title}》刚唱过，{minutes} 分钟后才能再点',
    'too_long': '《{title}》{duration}，太长了（上限 {max_duration}）',
    'instrumental': '这首歌几乎没有人声（纯音乐），唱不了',
    'rejected_before': '这首歌唱不了：{detail}',
    'vip_only': '这首是网易云的 VIP 歌，主播没有会员，拿不到完整版',
    'paid_album': '这首在网易云的付费专辑里，主播没买，拿不到',
    'no_audio': '拿不到这首歌的音频（可能下架了或者没有版权）',
    'local_missing': '歌库里的这首歌找不到文件了',
    'source_halted': '歌曲来源暂时用不了（触发了风控或登录失效），点歌先停一停',
    'source_down': '连不上歌曲来源，稍后再点',
    'source_error': '歌曲来源出错了，稍后再点',
    'source_busy': '歌曲来源正忙，稍后再点',
    'download_cap': '这场新下载的歌已经到上限（{max} 首），只能点唱过的歌',
    'request_timeout': '找这首歌花的时间太长了，稍后再点',
    'abandoned': '这次点歌已经作废了',
    'step_failed': '处理这首歌的时候出错了',
    'step_timeout': '处理这首歌花的时间太长，放弃了',
    'gpu_busy': '显卡一直被别的任务占着，没轮上处理这首歌',
    'not_configured': '点歌系统还没配置好',
    'not_downloaded': '这首歌的原曲文件不见了',
    'nothing_playing': '现在没在唱歌',
    'not_in_queue': '队列里没有这首歌',
    'no_such_position': '队列里没有第 {position} 首',
    'nothing_to_cancel': '没有在排的歌',
}


class _Blank(dict):
    def __missing__(self, key: str) -> str:
        return ''


def message(overrides: dict[str, str], code: str, **fields: object) -> str:
    """The text for `code`. A broken override (a stray brace) falls back to the default instead of failing a request."""
    text = overrides.get(code) or DEFAULT_MESSAGES.get(code) or code
    try:
        return text.format_map(_Blank(fields))
    except (ValueError, IndexError, KeyError, AttributeError):
        return DEFAULT_MESSAGES.get(code, code).format_map(_Blank(fields))
