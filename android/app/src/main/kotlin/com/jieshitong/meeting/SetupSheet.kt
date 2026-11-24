package com.jieshitong.meeting

import android.content.Intent
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.hjq.permissions.OnPermissionCallback
import com.hjq.permissions.Permission
import com.hjq.permissions.XXPermissions
import com.jieshitong.meeting.databinding.ItemSetupRowBinding
import com.jieshitong.meeting.databinding.SheetSetupBinding

/**
 * A bottom sheet with the three things that keep a meeting recording when
 * the phone is locked: microphone + notifications, the floating window, and
 * no battery restriction. Shown once per launch while any is missing.
 */
class SetupSheet(private val activity: AppCompatActivity) {
    private class Step(val title: String, val summary: String, val permissions: List<String>)

    private val basic = Step(
        "麦克风和通知", "用来录音，并在通知栏显示会议时长",
        listOfNotNull(Permission.RECORD_AUDIO, Permission.POST_NOTIFICATIONS),
    )
    private val floating = Step(
        "会议悬浮窗", "切到其他 App 时显示录音时长，点一下回到会议",
        listOf(Permission.SYSTEM_ALERT_WINDOW),
    )
    private val background = Step(
        "后台持续录音", "锁屏后不被系统省电功能停止",
        listOf(Permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS),
    )
    private val steps = listOf(basic, floating, background)

    private var dialog: BottomSheetDialog? = null
    private var binding: SheetSetupBinding? = null
    private var offeredThisLaunch = false

    fun showIfNeeded() {
        val open = dialog
        if (open != null && open.isShowing) {
            render() // Returning from a settings page: refresh the rows.
            return
        }
        if (offeredThisLaunch || steps.all(::isGranted)) return
        offeredThisLaunch = true
        show()
    }

    private fun show() {
        val sheet = SheetSetupBinding.inflate(activity.layoutInflater)
        binding = sheet
        bind(sheet.rowBasic, basic)
        bind(sheet.rowFloating, floating)
        bind(sheet.rowBackground, background)
        sheet.done.setOnClickListener { dialog?.dismiss() }
        dialog = BottomSheetDialog(activity).apply {
            setContentView(sheet.root)
            setOnDismissListener { dialog = null; binding = null }
            show()
        }
        render()
    }

    private fun bind(row: ItemSetupRowBinding, step: Step) {
        row.title.text = step.title
        row.summary.text = step.summary
        row.action.setOnClickListener { request(step) }
    }

    private fun render() {
        val sheet = binding ?: return
        renderRow(sheet.rowBasic, basic)
        renderRow(sheet.rowFloating, floating)
        renderRow(sheet.rowBackground, background)
        val allDone = steps.all(::isGranted)
        sheet.done.text = if (allDone) "完成" else "以后再说"
    }

    private fun renderRow(row: ItemSetupRowBinding, step: Step) {
        val granted = isGranted(step)
        row.action.isEnabled = !granted
        row.action.text = if (granted) "已开启" else "去开启"
        if (granted) {
            row.action.setTextColor(ContextCompat.getColor(activity, R.color.good_green))
            row.action.backgroundTintList = ColorStateList.valueOf(0x1A2F7D4F)
        }
    }

    private fun request(step: Step) {
        XXPermissions.with(activity)
            .permission(step.permissions)
            .request(object : OnPermissionCallback {
                override fun onGranted(permissions: MutableList<String>, allGranted: Boolean) = render()

                override fun onDenied(permissions: MutableList<String>, doNotAskAgain: Boolean) {
                    render()
                    when {
                        // Sideloaded apps on Android 13+ start with "restricted
                        // settings": the overlay switch is greyed out until the
                        // user allows them on the app info page.
                        step === floating && Build.VERSION.SDK_INT >= 33 -> explainRestrictedSettings()
                        // Android will not ask again: send the user to the app's settings page.
                        doNotAskAgain && step === basic -> XXPermissions.startPermissionActivity(activity, permissions)
                    }
                }
            })
    }

    private fun explainRestrictedSettings() {
        MaterialAlertDialogBuilder(activity)
            .setTitle("悬浮窗开关是灰色的？")
            .setMessage("这是安卓的安全限制，需要先解除一次：\n\n"
                    + "1. 点下面的「去应用信息」\n"
                    + "2. 点右上角「⋮」，选「允许受限制的设置」\n"
                    + "3. 回到这里，再点悬浮窗的「去开启」")
            .setPositiveButton("去应用信息") { _, _ ->
                activity.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
                )
            }
            .setNegativeButton("知道了", null)
            .show()
    }

    /** The page asked for the microphone after the user chose "don't ask again". */
    fun explainMicrophoneBlocked() {
        MaterialAlertDialogBuilder(activity)
            .setTitle("需要麦克风权限")
            .setMessage("开会录音需要使用麦克风。请在设置里允许「捷士通智能会议」使用麦克风，再回来点「开始会议」。")
            .setPositiveButton("去设置") { _, _ ->
                XXPermissions.startPermissionActivity(activity, Permission.RECORD_AUDIO)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun isGranted(step: Step) = XXPermissions.isGranted(activity, step.permissions)
}
