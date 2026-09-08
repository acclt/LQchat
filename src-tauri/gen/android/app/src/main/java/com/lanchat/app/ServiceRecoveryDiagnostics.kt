package com.lanchat.app

import android.content.Context
import android.os.Process
import org.json.JSONObject

/** Small persistent breadcrumb trail for diagnosing background-only recovery. */
object ServiceRecoveryDiagnostics {
    private const val PREFS = "lanchat_service_recovery"
    private const val STAGE = "stage"
    private const val DETAIL = "detail"
    private const val UPDATED_AT = "updated_at"
    private const val PID = "pid"

    @Synchronized
    fun record(context: Context, stage: String, detail: String = "") {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(STAGE, stage)
            .putString(DETAIL, detail.take(512))
            .putLong(UPDATED_AT, System.currentTimeMillis())
            .putInt(PID, Process.myPid())
            .commit()
    }

    @Synchronized
    fun read(context: Context): JSONObject {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return JSONObject()
            .put("stage", prefs.getString(STAGE, "unknown"))
            .put("detail", prefs.getString(DETAIL, ""))
            .put("updated_at", prefs.getLong(UPDATED_AT, 0L))
            .put("pid", prefs.getInt(PID, 0))
    }
}
