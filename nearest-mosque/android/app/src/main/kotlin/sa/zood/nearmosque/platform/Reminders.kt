package sa.zood.nearmosque.platform

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import sa.zood.nearmosque.MainActivity
import sa.zood.nearmosque.NearMosqueApp
import sa.zood.nearmosque.R
import sa.zood.nearmosque.core.PrayerCalculator
import sa.zood.nearmosque.core.PrayerEvent
import sa.zood.nearmosque.data.AppSettings
import sa.zood.nearmosque.ui.Format
import java.time.Instant

/**
 * Local prayer reminders: a bounded horizon (7 days) of one-shot alarms, rebuilt whenever settings
 * change, the app opens, the device reboots, or the time/zone changes. Nothing runs in the background
 * otherwise, and no audio is kept alive. Respects notification and exact-alarm permissions.
 */
class ReminderScheduler(private val context: Context, private val calculator: PrayerCalculator = PrayerCalculator()) {
    private val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    fun notificationsAllowed(): Boolean =
        (Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun exactAlarmsAllowed(): Boolean = Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()

    /** Returns the number of reminders scheduled. */
    fun reschedule(settings: AppSettings, now: Instant = Instant.now()): Int {
        cancelAll()
        val loc = settings.prayerLocation ?: return 0
        if (settings.reminders.isEmpty() || !notificationsAllowed()) return 0
        ensureChannel()
        val today = now.atZone(loc.zoneId).toLocalDate()
        var code = 0
        var count = 0
        for (d in 0 until HORIZON_DAYS) {
            val day = calculator.schedule(loc.location, today.plusDays(d.toLong()), loc.zoneId, settings.prayer)
            for (e in PrayerEvent.prayers) {
                val at = day[e]
                val requestCode = code++
                if (at == null || e !in settings.reminders || !at.isAfter(now)) continue
                val title = context.getString(R.string.reminder_title, context.getString(Format.prayerName(e)))
                val body = context.getString(R.string.reminder_body, loc.name, Format.time(context, at, loc.zoneId))
                val pi = PendingIntent.getBroadcast(
                    context, requestCode,
                    Intent(context, ReminderReceiver::class.java).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_BODY, body).putExtra(EXTRA_ID, requestCode),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                if (exactAlarmsAllowed()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at.toEpochMilli(), pi)
                else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at.toEpochMilli(), pi)
                count++
            }
        }
        return count
    }

    private fun cancelAll() {
        for (code in 0 until HORIZON_DAYS * PrayerEvent.prayers.size) {
            val pi = PendingIntent.getBroadcast(
                context, code, Intent(context, ReminderReceiver::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE,
            ) ?: continue
            alarms.cancel(pi)
            pi.cancel()
        }
    }

    private fun ensureChannel() {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.prayer_section), NotificationManager.IMPORTANCE_HIGH))
        }
    }

    companion object {
        const val HORIZON_DAYS = 7
        const val CHANNEL = "prayer_reminders"
        const val EXTRA_TITLE = "title"
        const val EXTRA_BODY = "body"
        const val EXTRA_ID = "id"
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, ReminderScheduler.CHANNEL)
            .setSmallIcon(R.drawable.ic_tab_prayer)
            .setContentTitle(intent.getStringExtra(ReminderScheduler.EXTRA_TITLE))
            .setContentText(intent.getStringExtra(ReminderScheduler.EXTRA_BODY))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        if (Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        ) {
            NotificationManagerCompat.from(context).notify(intent.getIntExtra(ReminderScheduler.EXTRA_ID, 0), n)
        }
        RescheduleReceiver.rescheduleAsync(context, goAsync())
    }
}

/** Boot, time, zone and exact-alarm-permission changes rebuild the bounded schedule. */
class RescheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = rescheduleAsync(context, goAsync())

    companion object {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

        fun rescheduleAsync(context: Context, pending: PendingResult?) {
            val app = context.applicationContext as NearMosqueApp
            scope.launch {
                try {
                    ReminderScheduler(app).reschedule(app.container.settings.settings.first())
                } finally {
                    pending?.finish()
                }
            }
        }
    }
}
