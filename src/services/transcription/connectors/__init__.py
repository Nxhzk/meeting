"""
Transcription connector implementations.

Alibaba Cloud ASR is the only transcription service this app uses.
"""

from .aliyun_asr import AliyunASRConnector

__all__ = ['AliyunASRConnector']
