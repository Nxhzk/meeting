package com.jieshitong.meeting

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.os.SystemClock
import android.provider.Settings
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.animation.ValueAnimator
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import com.jieshitong.meeting.databinding.FloatingMeetingBinding
import kotlin.math.abs

/**
 * The floating meeting window shown over other apps while a meeting runs
 * in the background. It can be dragged, snaps to the nearest screen edge,
 * and a tap brings the meeting page back.
 */
class FloatingWindow(context: Context, private val onTap: () -> Unit) {
    private companion object {
        // Remembered for the whole process so the window comes back where it was left.
        var savedX = -1
        var savedY = -1
    }

    private val themed = ContextThemeWrapper(context, R.style.AppTheme)
    private val windowManager = context.getSystemService(WindowManager::class.java)
    private var binding: FloatingMeetingBinding? = null
    private var params: WindowManager.LayoutParams? = null

    fun refresh(wanted: Boolean, phase: String, startedAt: Long) {
        val show = wanted && phase in MeetingPage.ACTIVE_PHASES && Settings.canDrawOverlays(themed)
        if (!show) {
            remove()
            return
        }
        val view = binding ?: add() ?: return
        render(view, phase, startedAt)
    }

    private fun render(view: FloatingMeetingBinding, phase: String, startedAt: Long) {
        val recording = phase == "recording"
        view.clock.base = SystemClock.elapsedRealtime() - (System.currentTimeMillis() - startedAt)
        if (recording) view.clock.start() else view.clock.stop()
        view.label.text = when (phase) {
            "recording" -> "录音中"
            "paused" -> "已暂停"
            else -> "保存中"
        }
        val dotColor = if (recording) R.color.brand_red else R.color.paused_amber
        ViewCompat.setBackgroundTintList(view.dot, ContextCompat.getColorStateList(themed, dotColor))
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun add(): FloatingMeetingBinding? {
        val view = FloatingMeetingBinding.inflate(LayoutInflater.from(themed))
        val metrics = themed.resources.displayMetrics
        val layout = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = if (savedX >= 0) savedX else metrics.widthPixels
            y = if (savedY >= 0) savedY else (metrics.heightPixels * 0.22).toInt()
        }
        try {
            windowManager.addView(view.root, layout)
        } catch (_: RuntimeException) {
            return null // Permission revoked in the meantime.
        }
        binding = view
        params = layout
        view.root.contentDescription = "会议录音中，点按回到会议"
        view.root.setOnTouchListener(DragListener())
        view.root.post { snapToEdge(animate = false) }
        return view
    }

    private fun remove() {
        val view = binding ?: return
        view.clock.stop()
        try {
            windowManager.removeView(view.root)
        } catch (_: RuntimeException) {
        }
        binding = null
        params = null
    }

    private fun snapToEdge(animate: Boolean) {
        val view = binding?.root ?: return
        val layout = params ?: return
        val width = themed.resources.displayMetrics.widthPixels
        val height = themed.resources.displayMetrics.heightPixels
        layout.y = layout.y.coerceIn(0, (height - view.height).coerceAtLeast(0))
        val target = if (layout.x + view.width / 2 < width / 2) 0 else width - view.width
        if (!animate) {
            layout.x = target
            update(layout)
            return
        }
        ValueAnimator.ofInt(layout.x, target).apply {
            duration = 180
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                layout.x = it.animatedValue as Int
                update(layout)
            }
            start()
        }
    }

    private fun update(layout: WindowManager.LayoutParams) {
        val view = binding?.root ?: return
        try {
            windowManager.updateViewLayout(view, layout)
        } catch (_: RuntimeException) {
        }
        savedX = layout.x
        savedY = layout.y
    }

    private inner class DragListener : android.view.View.OnTouchListener {
        private val slop = ViewConfiguration.get(themed).scaledTouchSlop
        private var downX = 0f
        private var downY = 0f
        private var startX = 0
        private var startY = 0
        private var dragging = false

        override fun onTouch(view: android.view.View, event: MotionEvent): Boolean {
            val layout = params ?: return false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX; downY = event.rawY
                    startX = layout.x; startY = layout.y
                    dragging = false
                }

                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX
                    val dy = event.rawY - downY
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) dragging = true
                    if (dragging) {
                        layout.x = startX + dx.toInt()
                        layout.y = startY + dy.toInt()
                        update(layout)
                    }
                }

                MotionEvent.ACTION_UP -> {
                    if (dragging) snapToEdge(animate = true) else {
                        view.performClick()
                        onTap()
                    }
                }

                MotionEvent.ACTION_CANCEL -> if (dragging) snapToEdge(animate = true)
            }
            return true
        }
    }
}
