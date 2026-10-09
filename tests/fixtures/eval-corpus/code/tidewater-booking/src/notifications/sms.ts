import { config } from '../config.js'
import { withRetry } from '../lib/retry.js'

const REMINDER_HOURS_BEFORE = 48

/** Trip reminder by SMS two days before departure, with the pickup point and the guide's phone number. */
export async function sendTripReminderSms(phone: string, tripName: string, pickup: string, guidePhone: string) {
  const text = 'Reminder: ' + tripName + ' leaves in ' + REMINDER_HOURS_BEFORE + ' hours from ' + pickup + '. Guide: ' + guidePhone
  await withRetry(() => sendSms(phone, text), { attempts: 3 })
}

async function sendSms(to: string, text: string) {
  const res = await fetch('https://api.' + config.sms.provider + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: config.sms.sender, to, text })
  })
  if (!res.ok) throw new Error('SMS provider returned ' + res.status)
}
