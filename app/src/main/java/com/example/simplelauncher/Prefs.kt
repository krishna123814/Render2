package com.example.simplelauncher

import android.content.Context
import java.security.MessageDigest
import java.security.SecureRandom

/** Saari settings ek jagah: grid, icon size, hidden apps, favorites, secret word, PIN. */
internal class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("lion_launcher", Context.MODE_PRIVATE)

    var columns: Int
        get() = sp.getInt("cols", 4)
        set(v) {
            sp.edit().putInt("cols", v).apply()
        }

    var iconDp: Int
        get() = sp.getInt("icon", 48)
        set(v) {
            sp.edit().putInt("icon", v).apply()
        }

    var secret: String
        get() = sp.getString("secret", DEFAULT_SECRET) ?: DEFAULT_SECRET
        set(v) {
            sp.edit().putString("secret", v).apply()
        }

    // key = app ka component naam (package/activity)
    val hidden: Set<String>
        get() = HashSet(sp.getStringSet("hidden", emptySet()) ?: emptySet())

    fun setHidden(key: String, hide: Boolean) {
        val s = HashSet(hidden)
        if (hide) s.add(key) else s.remove(key)
        sp.edit().putStringSet("hidden", s).apply()
    }

    var favs: List<String>
        get() = (sp.getString("favs", "") ?: "").split(";").filter { it.isNotEmpty() }
        set(v) {
            sp.edit().putString("favs", v.joinToString(";")).apply()
        }

    fun hasPin() = sp.contains("pin_hash")

    fun setPin(pin: String?) {
        if (pin == null) {
            sp.edit().remove("pin_hash").remove("pin_salt").apply()
            return
        }
        val salt = ByteArray(8).also { SecureRandom().nextBytes(it) }.toHex()
        sp.edit().putString("pin_salt", salt).putString("pin_hash", hash(salt, pin)).apply()
    }

    fun checkPin(pin: String): Boolean {
        val salt = sp.getString("pin_salt", null) ?: return false
        return hash(salt, pin) == sp.getString("pin_hash", null)
    }

    private fun hash(salt: String, pin: String): String =
        MessageDigest.getInstance("SHA-256").digest((salt + pin).toByteArray()).toHex()

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    companion object {
        const val DEFAULT_SECRET = "lion"
    }
}
