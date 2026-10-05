/**
 * Reading what a merchant or the profile host sent: UTF-8 checked, then
 * strict JSON. The rules are @dina/ucp's, shared with AppView's merchant index.
 */

export { jsonOrUndefined, readJsonBytes, utf8Text, type JsonRead } from '@dina/ucp';
