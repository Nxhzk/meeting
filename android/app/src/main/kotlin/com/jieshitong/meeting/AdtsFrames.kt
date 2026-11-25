package com.jieshitong.meeting

/**
 * ADTS（AAC 的流式封装）的帧切分：每一帧自带 7 字节帧头，帧与帧可以直接拼接。
 *
 * 录音文件一边写一边读，读到的末尾常常是半帧：只取完整的帧，半帧留到下一次。
 * 开头不是帧头（文件头异常、数据损坏）时向后找，找到连续两帧都对得上的位置再开始。
 */
object AdtsFrames {
    private const val HEADER = 7
    /** 超过这么长还找不到任何合法帧，认为这一段已经坏了，放弃。 */
    private const val HOPELESS_BYTES = 256 * 1024

    private sealed interface Probe {
        data class Frame(val length: Int) : Probe
        /** 帧头对得上，但整帧还没写完。 */
        data object Incomplete : Probe
        data object NotAFrame : Probe
    }

    private fun probe(bytes: ByteArray, pos: Int): Probe {
        if (pos + 2 > bytes.size) return Probe.Incomplete          // 连同步字都还没写完
        if (bytes[pos].toInt() and 0xFF != 0xFF || bytes[pos + 1].toInt() and 0xF0 != 0xF0) return Probe.NotAFrame
        if (pos + HEADER > bytes.size) return Probe.Incomplete     // 帧头没写完
        val length = ((bytes[pos + 3].toInt() and 0x03) shl 11) or ((bytes[pos + 4].toInt() and 0xFF) shl 3) or
            ((bytes[pos + 5].toInt() and 0xE0) ushr 5)
        if (length < HEADER) return Probe.NotAFrame
        return if (pos + length > bytes.size) Probe.Incomplete else Probe.Frame(length)
    }

    /**
     * 返回 (第一帧的位置, 最后一个完整帧的结尾)；一帧都没有时返回 (0, 0)。
     * 开头那一帧只是还没写完时也返回 (0, 0)：等下一次，不要往后乱找。
     */
    fun range(bytes: ByteArray): Pair<Int, Int> {
        var start = 0
        when (probe(bytes, 0)) {
            is Probe.Frame -> Unit
            Probe.Incomplete -> return 0 to 0
            Probe.NotAFrame -> {
                start = resync(bytes)
                if (start < 0) return 0 to 0
            }
        }
        var pos = start
        while (true) {
            val frame = probe(bytes, pos) as? Probe.Frame ?: break
            pos += frame.length
        }
        return start to pos
    }

    /** 往后找一个可信的起点：这里是一帧，并且紧接着又是一帧（或者正好到数据末尾）。找不到返回 -1。 */
    private fun resync(bytes: ByteArray): Int {
        var i = 1
        while (i + 2 <= bytes.size) {
            val here = probe(bytes, i)
            if (here is Probe.Frame) {
                val end = i + here.length
                if (end == bytes.size || probe(bytes, end) is Probe.Frame) return i
            }
            i += 1
        }
        return -1
    }

    /** 这一段数据是否已经没救了（很长却一帧都切不出来）。 */
    fun hopeless(bytes: ByteArray): Boolean = bytes.size > HOPELESS_BYTES && range(bytes).let { it.second <= it.first }
}
