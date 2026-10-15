package com.example.simplelauncher

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs

internal class AppItem(val label: String, val icon: Drawable, val intent: Intent)

/**
 * Minimal launcher:
 *  - Home screen = sirf wallpaper
 *  - Neeche se upar drag karo = app drawer (grid)
 *  - Drawer ke top par neeche drag / Back / Home = drawer band
 */
@Suppress("DEPRECATION")
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var drawer: View
    private lateinit var grid: GridView

    private val apps = ArrayList<AppItem>()
    private val adapter = AppAdapter()

    private var isOpen = false
    private var dragging = false
    private var downX = 0f
    private var downY = 0f
    private var baseTy = 0f
    private var slop = 0
    private var tracker: VelocityTracker? = null

    private val pkgReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            loadApps()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        root = findViewById(R.id.root)
        drawer = findViewById(R.id.drawer)
        grid = findViewById(R.id.grid)
        grid.adapter = adapter
        slop = ViewConfiguration.get(this).scaledTouchSlop

        // Status bar / nav bar ke peeche tak layout
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        root.setOnApplyWindowInsetsListener { _, insets ->
            grid.setPadding(
                dp(8),
                insets.systemWindowInsetTop + dp(24),
                dp(8),
                insets.systemWindowInsetBottom + dp(16)
            )
            insets
        }

        // Band drawer hamesha screen ke neeche rahe
        root.addOnLayoutChangeListener { _, _, top, _, bottom, _, _, _, _ ->
            if (!isOpen && !dragging) drawer.translationY = (bottom - top).toFloat()
        }

        grid.setOnItemClickListener { _, _, pos, _ -> launch(apps[pos]) }

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addDataScheme("package")
        }
        registerReceiver(pkgReceiver, filter)

        loadApps()
    }

    override fun onDestroy() {
        unregisterReceiver(pkgReceiver)
        super.onDestroy()
    }

    // Home button dabane par drawer band
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (isOpen) settle(false)
    }

    override fun onBackPressed() {
        if (isOpen) settle(false)
        // launcher kabhi band nahi hota
    }

    // ---------- drag up / drag down ----------

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.rawX
                downY = ev.rawY
                dragging = false
                tracker?.recycle()
                tracker = VelocityTracker.obtain().also { it.addMovement(ev) }
            }
            MotionEvent.ACTION_MOVE -> {
                tracker?.addMovement(ev)
                if (!dragging) {
                    val dy = ev.rawY - downY
                    val dx = ev.rawX - downX
                    val start = if (isOpen) {
                        dy > slop && !grid.canScrollVertically(-1)
                    } else {
                        dy < -slop
                    }
                    if (start && abs(dy) > abs(dx)) {
                        dragging = true
                        baseTy = drawer.translationY
                        downY = ev.rawY
                        drawer.animate().cancel()
                        // grid ka press/scroll cancel karo
                        val c = MotionEvent.obtain(ev)
                        c.action = MotionEvent.ACTION_CANCEL
                        super.dispatchTouchEvent(c)
                        c.recycle()
                    }
                }
                if (dragging) {
                    drawer.translationY =
                        (baseTy + ev.rawY - downY).coerceIn(0f, root.height.toFloat())
                    return true
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                tracker?.addMovement(ev)
                val wasDragging = dragging
                if (wasDragging) {
                    tracker?.computeCurrentVelocity(1000)
                    val vy = tracker?.yVelocity ?: 0f
                    settle(
                        when {
                            vy < -800f -> true
                            vy > 800f -> false
                            else -> drawer.translationY < root.height / 2f
                        }
                    )
                }
                dragging = false
                tracker?.recycle()
                tracker = null
                if (wasDragging) return true
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun settle(open: Boolean) {
        isOpen = open
        val target = if (open) 0f else root.height.toFloat()
        drawer.animate().cancel()
        drawer.animate()
            .translationY(target)
            .setDuration(220)
            .withEndAction { if (!isOpen) grid.setSelection(0) }
            .start()
    }

    // ---------- apps ----------

    private fun launch(item: AppItem) {
        try {
            startActivity(item.intent)
        } catch (_: Exception) {
            return
        }
        // app ke peeche drawer turant band
        drawer.animate().cancel()
        isOpen = false
        drawer.translationY = root.height.toFloat()
        grid.setSelection(0)
    }

    private fun loadApps() {
        Thread {
            val pm = packageManager
            val query = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            val list = pm.queryIntentActivities(query, 0)
                .filter { it.activityInfo.packageName != packageName }
                .map {
                    val ai = it.activityInfo
                    AppItem(
                        it.loadLabel(pm).toString(),
                        it.loadIcon(pm),
                        Intent(Intent.ACTION_MAIN)
                            .addCategory(Intent.CATEGORY_LAUNCHER)
                            .setComponent(ComponentName(ai.packageName, ai.name))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                    )
                }
                .sortedBy { it.label.lowercase() }
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                apps.clear()
                apps.addAll(list)
                adapter.notifyDataSetChanged()
            }
        }.start()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun makeCell(): View {
        val cell = LinearLayout(this)
        cell.orientation = LinearLayout.VERTICAL
        cell.gravity = Gravity.CENTER_HORIZONTAL

        val icon = ImageView(this)
        icon.layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))

        val label = TextView(this)
        label.setTextColor(Color.WHITE)
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        label.maxLines = 1
        label.ellipsize = TextUtils.TruncateAt.END
        label.gravity = Gravity.CENTER
        label.setPadding(dp(2), dp(6), dp(2), 0)
        label.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )

        cell.addView(icon)
        cell.addView(label)
        return cell
    }

    private inner class AppAdapter : BaseAdapter() {
        override fun getCount() = apps.size
        override fun getItem(position: Int) = apps[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val cell = (convertView ?: makeCell()) as ViewGroup
            val item = apps[position]
            (cell.getChildAt(0) as ImageView).setImageDrawable(item.icon)
            (cell.getChildAt(1) as TextView).text = item.label
            return cell
        }
    }
}
