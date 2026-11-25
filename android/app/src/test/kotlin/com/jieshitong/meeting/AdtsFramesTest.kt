package com.jieshitong.meeting

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdtsFramesTest {
    /** 造一帧：7 字节帧头 + 负载，总长 length。负载里不出现 0xFF，避免被误认成帧头。 */
    private fun frame(length: Int, fill: Int = 0x11): ByteArray {
        val bytes = ByteArray(length) { fill.toByte() }
        bytes[0] = 0xFF.toByte()
        bytes[1] = 0xF1.toByte()                       // 同步字 + MPEG-4 + 无 CRC
        bytes[2] = 0x50
        bytes[3] = (0x80 or ((length shr 11) and 0x03)).toByte()
        bytes[4] = ((length shr 3) and 0xFF).toByte()
        bytes[5] = (((length and 0x07) shl 5) or 0x1F).toByte()
        bytes[6] = 0xFC.toByte()
        return bytes
    }

    private fun join(vararg parts: ByteArray) = parts.fold(ByteArray(0)) { acc, part -> acc + part }

    @Test fun `whole frames are all taken`() {
        val data = join(frame(100), frame(120), frame(90))
        assertEquals(0 to 310, AdtsFrames.range(data))
    }

    @Test fun `a half written last frame is left for the next time`() {
        val data = join(frame(100), frame(120), frame(90).copyOf(40))
        assertEquals(0 to 220, AdtsFrames.range(data))
    }

    @Test fun `a first frame that is not fully written yet waits instead of searching`() {
        // 第一帧只写了一半：不能往后「找」，否则会把负载里碰巧像帧头的字节当成起点
        val half = frame(200).copyOf(120)
        half[60] = 0xFF.toByte(); half[61] = 0xF1.toByte(); half[62] = 0x50; half[63] = 0x80.toByte()
        half[64] = 0x0C; half[65] = 0x1F; half[66] = 0xFC.toByte()    // 一段看起来像 100 字节帧头的负载
        assertEquals(0 to 0, AdtsFrames.range(half))
        // 不足 2 字节、不足 7 字节的开头也一样
        assertEquals(0 to 0, AdtsFrames.range(byteArrayOf(0xFF.toByte())))
        assertEquals(0 to 0, AdtsFrames.range(frame(100).copyOf(5)))
        assertEquals(0 to 0, AdtsFrames.range(ByteArray(0)))
    }

    @Test fun `garbage before the first frame is skipped`() {
        val garbage = ByteArray(33) { 0x22 }
        val data = join(garbage, frame(100), frame(100), frame(80))
        assertEquals(33 to 313, AdtsFrames.range(data))
    }

    @Test fun `a lone false sync word in garbage is not trusted`() {
        // 垃圾里有一个看着像帧的东西，但它后面接不上第二帧
        val fake = frame(50)
        val data = join(ByteArray(10) { 0x22 }, fake, ByteArray(60) { 0x22 }, frame(100), frame(100))
        val (from, to) = AdtsFrames.range(data)
        assertEquals(10 + 50 + 60, from)
        assertEquals(from + 200, to)
    }

    @Test fun `no frame at all`() {
        assertEquals(0 to 0, AdtsFrames.range(ByteArray(1000) { 0x22 }))
        assertEquals(0 to 0, AdtsFrames.range(ByteArray(1000) { 0xFF.toByte() }))
    }

    @Test fun `absurd frame lengths are rejected`() {
        val bad = frame(100)
        bad[3] = 0x80.toByte(); bad[4] = 0; bad[5] = 0x1F    // 长度 0 < 7
        assertEquals(0 to 0, AdtsFrames.range(bad))
    }

    @Test fun `a short garbage run is not hopeless but a long one is`() {
        assertFalse(AdtsFrames.hopeless(ByteArray(1000) { 0x22 }))
        assertTrue(AdtsFrames.hopeless(ByteArray(300 * 1024) { 0x22 }))
        assertFalse(AdtsFrames.hopeless(join(ByteArray(300 * 1024) { 0x22 }, frame(100), frame(100))))
    }

    @Test fun `cutting a long recording in arbitrary pieces loses nothing`() {
        // 模拟「边写边读」：按随机大小读文件，每次只取完整帧，剩下的下次接着读。拼起来必须和原文件一模一样
        val all = join(*Array(400) { frame(80 + (it * 7) % 120, 0x10 + it % 100) })
        val random = java.util.Random(42)
        var offset = 0
        var read = 0
        val out = java.io.ByteArrayOutputStream()
        while (read < all.size) {
            read = minOf(all.size, read + 1 + random.nextInt(900))
            val window = all.copyOfRange(offset, read)
            val (from, to) = AdtsFrames.range(window)
            if (to > from) {
                assertEquals(0, from)
                out.write(window, from, to - from)
                offset += to
            }
        }
        assertEquals(all.size, offset)
        assertTrue(all.contentEquals(out.toByteArray()))
    }
}
