package com.example.simplelauncher

import android.app.Activity
import android.app.AlertDialog
import android.app.role.RoleManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import kotlin.math.abs
import kotlin.math.min

internal class AppItem(
    val key: String,        // component naam: package/activity
    val pkg: String,
    val label: String,
    val icon: Drawable,
    val intent: Intent,
    val system: Boolean
)

/**
 * Lion Launcher:
 *  - Home = wallpaper + (optional) favorites row
 *  - Neeche se upar drag = app drawer (search bar + grid)
 *  - Home par neeche drag = notification panel
 *  - Home par long-press = settings
 *  - App long-press = menu (favorite / hide / app info / uninstall)
 *  - Search bar mein secret word likho = hidden apps (PIN laga ho to PIN ke baad)
 */
@Suppress("DEPRECATION")
class MainActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var root: FrameLayout
    private lateinit var drawer: View
    private lateinit var drawerBox: View
    private lateinit var grid: GridView
    private lateinit var search: EditText
    private lateinit var favRow: LinearLayout

    private val allApps = ArrayList<AppItem>()
    private val visible = ArrayList<AppItem>()
    private val adapter = AppAdapter()

    private var hiddenMode = false
    private var isOpen = false
    private var dragging = false
    private var pulling = false
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
        prefs = Prefs(this)
        setContentView(R.layout.activity_main)

        root = findViewById(R.id.root)
        drawer = findViewById(R.id.drawer)
        drawerBox = findViewById(R.id.drawerBox)
        grid = findViewById(R.id.grid)
        search = findViewById(R.id.search)
        favRow = findViewById(R.id.favRow)

        grid.adapter = adapter
        grid.numColumns = prefs.columns
        slop = ViewConfiguration.get(this).scaledTouchSlop

        // Status bar / nav bar ke peeche tak layout
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        root.setOnApplyWindowInsetsListener { _, insets ->
            val top = insets.systemWindowInsetTop
            val bottom = insets.systemWindowInsetBottom // keyboard khula ho to wo bhi isme aata hai
            drawerBox.setPadding(dp(8), top + dp(16), dp(8), bottom)
            favRow.setPadding(0, 0, 0, insets.systemWindowInsetBottom + dp(24))
            insets
        }

        // Band drawer hamesha screen ke neeche rahe
        root.addOnLayoutChangeListener { _, _, top, _, bottom, _, _, _, _ ->
            if (!isOpen && !dragging) drawer.translationY = (bottom - top).toFloat()
        }

        grid.setOnItemClickListener { _, _, pos, _ -> launch(visible[pos]) }
        grid.setOnItemLongClickListener { _, _, pos, _ ->
            showMenu(visible[pos])
            true
        }

        // Home par khali jagah long-press = settings
        root.setOnLongClickListener {
            if (isOpen) {
                false
            } else {
                root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                showSettings()
                true
            }
        }

        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                onSearchChanged(s?.toString()?.trim().orEmpty())
            }
        })
        search.setOnEditorActionListener { _, _, _ ->
            if (search.text.isNotBlank() && visible.isNotEmpty()) launch(visible[0])
            true
        }

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addDataScheme("package")
        }
        registerReceiver(pkgReceiver, filter)

        loadApps()
        askDefaultIfNeeded(intent)
    }

    override fun onDestroy() {
        unregisterReceiver(pkgReceiver)
        super.onDestroy()
    }

    override fun onPause() {
        super.onPause()
        // Hidden apps ki list screen se jaate hi band
        if (hiddenMode) resetSearch()
    }

    // Home button dabane par drawer band
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (isOpen) settle(false)
        askDefaultIfNeeded(intent)
    }

    override fun onBackPressed() {
        if (isOpen) settle(false)
        // launcher kabhi band nahi hota
    }

    // App icon se khola ho to "default home app" banane ka dialog dikhao
    private fun askDefaultIfNeeded(i: Intent?) {
        if (i == null || !i.hasCategory(Intent.CATEGORY_LAUNCHER)) return
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                val rm = getSystemService(RoleManager::class.java)
                if (rm.isRoleAvailable(RoleManager.ROLE_HOME) && !rm.isRoleHeld(RoleManager.ROLE_HOME)) {
                    startActivityForResult(rm.createRequestRoleIntent(RoleManager.ROLE_HOME), 1)
                }
            } else {
                startActivity(Intent(Settings.ACTION_HOME_SETTINGS))
            }
        } catch (_: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_SETTINGS))
            } catch (_: Exception) {
            }
        }
    }

    // ---------- gestures: drag up / drag down ----------

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.rawX
                downY = ev.rawY
                dragging = false
                pulling = false
                tracker?.recycle()
                tracker = VelocityTracker.obtain().also { it.addMovement(ev) }
            }
            MotionEvent.ACTION_MOVE -> {
                tracker?.addMovement(ev)
                if (!dragging && !pulling) {
                    val dy = ev.rawY - downY
                    val dx = ev.rawX - downX
                    if (abs(dy) > abs(dx)) {
                        if (isOpen) {
                            if (dy > slop && !grid.canScrollVertically(-1)) startDrag(ev)
                        } else {
                            if (dy < -slop) {
                                startDrag(ev)
                            } else if (dy > slop) {
                                pulling = true
                                cancelChildren(ev)
                            }
                        }
                    }
                }
                if (dragging) {
                    drawer.translationY =
                        (baseTy + ev.rawY - downY).coerceIn(0f, root.height.toFloat())
                    return true
                }
                if (pulling) return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                tracker?.addMovement(ev)
                val wasDragging = dragging
                val wasPulling = pulling
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
                } else if (wasPulling && ev.actionMasked == MotionEvent.ACTION_UP &&
                    ev.rawY - downY > dp(60)
                ) {
                    expandNotifications()
                }
                dragging = false
                pulling = false
                tracker?.recycle()
                tracker = null
                if (wasDragging || wasPulling) return true
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun startDrag(ev: MotionEvent) {
        dragging = true
        baseTy = drawer.translationY
        downY = ev.rawY
        drawer.animate().cancel()
        cancelChildren(ev)
    }

    // grid ka press/scroll cancel karo
    private fun cancelChildren(ev: MotionEvent) {
        val c = MotionEvent.obtain(ev)
        c.action = MotionEvent.ACTION_CANCEL
        super.dispatchTouchEvent(c)
        c.recycle()
    }

    private fun settle(open: Boolean) {
        isOpen = open
        if (!open) resetSearch()
        val target = if (open) 0f else root.height.toFloat()
        drawer.animate().cancel()
        drawer.animate()
            .translationY(target)
            .setDuration(220)
            .withEndAction { if (!isOpen) grid.setSelection(0) }
            .start()
    }

    private fun expandNotifications() {
        try {
            val sb = getSystemService("statusbar") ?: return
            sb.javaClass.getMethod("expandNotificationsPanel").invoke(sb)
        } catch (_: Exception) {
            // kuch phones is par roak lagate hain
        }
    }

    // ---------- search + hidden apps ----------

    private fun onSearchChanged(text: String) {
        val secret = prefs.secret
        if (secret.isNotEmpty() && text.equals(secret, ignoreCase = true)) {
            if (!hiddenMode) {
                refresh()
                requirePin(onCancel = { search.setText("") }) {
                    hiddenMode = true
                    refresh()
                }
            }
        } else {
            hiddenMode = false
            refresh()
        }
    }

    private fun resetSearch() {
        hiddenMode = false
        if (search.text.isNotEmpty()) search.setText("")
        search.clearFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(search.windowToken, 0)
        refresh()
    }

    private fun refresh() {
        val hidden = prefs.hidden
        val q = search.text.toString().trim().lowercase()
        visible.clear()
        for (a in allApps) {
            val isHidden = a.key in hidden
            if (hiddenMode) {
                if (isHidden) visible.add(a)
            } else if (!isHidden && (q.isEmpty() || a.label.lowercase().contains(q))) {
                visible.add(a)
            }
        }
        adapter.notifyDataSetChanged()
        renderFavs()
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
        resetSearch()
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
                    val cn = ComponentName(ai.packageName, ai.name)
                    AppItem(
                        cn.flattenToString(),
                        ai.packageName,
                        it.loadLabel(pm).toString(),
                        it.loadIcon(pm),
                        Intent(Intent.ACTION_MAIN)
                            .addCategory(Intent.CATEGORY_LAUNCHER)
                            .setComponent(cn)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED),
                        (ai.applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0
                    )
                }
                .sortedBy { it.label.lowercase() }
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                allApps.clear()
                allApps.addAll(list)
                refresh()
            }
        }.start()
    }

    // ---------- favorites ----------

    private fun renderFavs() {
        favRow.removeAllViews()
        val hidden = prefs.hidden
        // 5 icons screen mein hamesha fit hon
        val maxPx = (resources.displayMetrics.widthPixels - dp(32) - 5 * dp(12)) / 5
        val size = min(dp(prefs.iconDp), maxPx)
        var n = 0
        for (k in prefs.favs) {
            val app = allApps.firstOrNull { it.key == k } ?: continue
            if (app.key in hidden) continue
            val iv = ImageView(this)
            val lp = LinearLayout.LayoutParams(size, size)
            lp.setMargins(dp(6), 0, dp(6), 0)
            iv.layoutParams = lp
            iv.setImageDrawable(app.icon)
            iv.setOnClickListener { launch(app) }
            iv.setOnLongClickListener {
                showMenu(app)
                true
            }
            favRow.addView(iv)
            n++
            if (n >= MAX_FAVS) break
        }
        favRow.visibility = if (n == 0) View.GONE else View.VISIBLE
    }

    private fun toggleFav(app: AppItem) {
        val f = prefs.favs.toMutableList()
        if (!f.remove(app.key)) {
            if (f.size >= MAX_FAVS) {
                toast("Favorites full (max $MAX_FAVS)")
                return
            }
            f.add(app.key)
        }
        prefs.favs = f
        renderFavs()
    }

    // ---------- long-press menu ----------

    private fun showMenu(app: AppItem) {
        val labels = ArrayList<String>()
        val actions = ArrayList<() -> Unit>()
        if (app.key in prefs.hidden) {
            labels.add("Unhide")
            actions.add {
                prefs.setHidden(app.key, false)
                refresh()
            }
        } else {
            labels.add(if (app.key in prefs.favs) "Remove from favorites" else "Add to favorites")
            actions.add { toggleFav(app) }
            labels.add("Hide")
            actions.add {
                prefs.setHidden(app.key, true)
                prefs.favs = prefs.favs.filter { it != app.key }
                refresh()
            }
        }
        labels.add("App info")
        actions.add {
            startSafe(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${app.pkg}"))
            )
        }
        if (!app.system) {
            labels.add("Uninstall")
            actions.add { startSafe(Intent(Intent.ACTION_DELETE, Uri.parse("package:${app.pkg}"))) }
        }
        dlg().setTitle(app.label)
            .setItems(labels.toTypedArray()) { _, i -> actions[i]() }
            .show()
    }

    private fun startSafe(i: Intent) {
        try {
            startActivity(i)
        } catch (_: Exception) {
            toast("Ye nahi khul paaya")
        }
    }

    // ---------- settings + PIN ----------

    private fun showSettings() {
        val items = arrayOf(
            "Grid columns: ${prefs.columns}",
            "Icon size: ${prefs.iconDp}",
            "Secret word",
            if (prefs.hasPin()) "Change / remove PIN" else "Set PIN"
        )
        dlg().setTitle("Settings").setItems(items) { _, i ->
            when (i) {
                0 -> pick("Grid columns", intArrayOf(3, 4, 5, 6), prefs.columns) {
                    prefs.columns = it
                    applySettings()
                }
                1 -> pick("Icon size", intArrayOf(40, 48, 56, 64), prefs.iconDp) {
                    prefs.iconDp = it
                    applySettings()
                }
                2 -> requirePin {
                    askText("New secret word", false) { w ->
                        if (w.isEmpty()) {
                            toast("Khali nahi ho sakta")
                        } else {
                            prefs.secret = w
                            toast("Secret word save ho gaya")
                        }
                    }
                }
                3 -> if (prefs.hasPin()) {
                    requirePin {
                        askText(
                            "New PIN (min 4 digits)", true,
                            neutralLabel = "Remove PIN",
                            onNeutral = {
                                prefs.setPin(null)
                                toast("PIN hat gaya")
                            }
                        ) { savePin(it) }
                    }
                } else {
                    askText("Set PIN (min 4 digits)", true) { savePin(it) }
                }
            }
        }.show()
    }

    private fun applySettings() {
        grid.numColumns = prefs.columns
        adapter.notifyDataSetChanged()
        renderFavs()
    }

    private fun savePin(p: String) {
        if (p.length < 4) {
            toast("PIN kam se kam 4 digit ka ho")
        } else {
            prefs.setPin(p)
            toast("PIN save ho gaya")
        }
    }

    // PIN laga ho to pooch ke hi aage badho
    private fun requirePin(onCancel: () -> Unit = {}, onOk: () -> Unit) {
        if (!prefs.hasPin()) {
            onOk()
            return
        }
        askText("Enter PIN", true, onCancel = onCancel) { pin ->
            if (prefs.checkPin(pin)) {
                onOk()
            } else {
                toast("Galat PIN")
                onCancel()
            }
        }
    }

    private fun pick(title: String, values: IntArray, current: Int, onPick: (Int) -> Unit) {
        val labels = values.map { it.toString() }.toTypedArray()
        dlg().setTitle(title)
            .setSingleChoiceItems(labels, values.indexOf(current)) { d, i ->
                onPick(values[i])
                d.dismiss()
            }
            .show()
    }

    private fun askText(
        title: String,
        numeric: Boolean,
        neutralLabel: String? = null,
        onNeutral: (() -> Unit)? = null,
        onCancel: () -> Unit = {},
        onOk: (String) -> Unit
    ) {
        val et = EditText(this)
        et.inputType = if (numeric) {
            InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        } else {
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        et.maxLines = 1
        val box = FrameLayout(this)
        box.setPadding(dp(20), dp(8), dp(20), 0)
        box.addView(et)

        val b = dlg().setTitle(title).setView(box)
            .setPositiveButton("OK") { _, _ -> onOk(et.text.toString().trim()) }
            .setNegativeButton("Cancel") { _, _ -> onCancel() }
            .setOnCancelListener { onCancel() }
        if (neutralLabel != null) b.setNeutralButton(neutralLabel) { _, _ -> onNeutral?.invoke() }
        val d = b.create()
        d.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
        d.show()
        et.requestFocus()
    }

    private fun dlg() = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ---------- grid cell ----------

    private fun makeCell(): View {
        val cell = LinearLayout(this)
        cell.orientation = LinearLayout.VERTICAL
        cell.gravity = Gravity.CENTER_HORIZONTAL

        val icon = ImageView(this)
        icon.layoutParams = LinearLayout.LayoutParams(dp(prefs.iconDp), dp(prefs.iconDp))

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
        override fun getCount() = visible.size
        override fun getItem(position: Int) = visible[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val cell = (convertView ?: makeCell()) as ViewGroup
            val item = visible[position]
            val icon = cell.getChildAt(0) as ImageView
            val px = dp(prefs.iconDp)
            val lp = icon.layoutParams
            if (lp.width != px || lp.height != px) {
                lp.width = px
                lp.height = px
                icon.layoutParams = lp
            }
            icon.setImageDrawable(item.icon)
            (cell.getChildAt(1) as TextView).text = item.label
            return cell
        }
    }

    companion object {
        private const val MAX_FAVS = 5
    }
}
