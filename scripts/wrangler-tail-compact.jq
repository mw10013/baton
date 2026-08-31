def timestamp:
  . as $ms
  | ($ms / 1000 | localtime | strftime("%Y-%m-%d %H:%M:%S"))
    + "."
    + (("000" + (($ms % 1000 | floor) | tostring))[-3:]);

def message:
  if type == "array" then
    map(if type == "string" then . else tojson end) | join(" ")
  elif type == "string" then .
  else tojson
  end;

def diagnostics_message:
  ((.channel // "diagnostics") + " " + (.message | message));

def annotations:
  if . == null or . == {} then "" else " " + (. | tojson) end;

def lifecycle_context:
  (.diagnosticsChannelEvents // []
    | map(.message? | select(type == "object") | { type, agent, name, code: .payload.code } | with_entries(select(.value != null)))
    | first) // {};

def event_context($event):
  ($event.diagnosticsChannelEvents // []
    | map(.message? | select(type == "object") | { type, agent, name } | with_entries(select(.value != null)))
    | first) as $context
  | ($context | annotations);

def structured_log:
  if (.message | type) == "array" and (.message | length) == 1 and (.message[0] | type) == "string" then
    (.message[0] | fromjson?) as $parsed
    | if ($parsed | type) == "object" and ($parsed.message | type) == "string" then
      {
        timestamp: .timestamp,
        level: (($parsed.level // .level) | ascii_downcase),
        message: ($parsed.message + ($parsed.annotations | annotations))
      }
    else
      {
        timestamp: .timestamp,
        level: .level,
        message: (.message | message)
      }
    end
  else
    {
      timestamp: .timestamp,
      level: .level,
      message: (.message | message)
    }
  end;

def platform_log:
  if .event.request then
    {
      timestamp: .eventTimestamp,
      level: "info",
      message: ((.event.request.method | ascii_upcase) + " " + .event.request.url)
    }
  elif .event.rpcMethod then
    {
      timestamp: .eventTimestamp,
      level: "info",
      message: .event.rpcMethod
    }
  elif .event.getWebSocketEvent then
    lifecycle_context as $context
    | {
      timestamp: .eventTimestamp,
      level: "info",
      message: (("websocket:" + .event.getWebSocketEvent.webSocketEventType) + ($context | annotations))
    }
  else empty end;

def first_exception:
  . as $event
  | ($event.exceptions // [] | first) as $exception
  | if $exception == null then empty else {
    timestamp: ($exception.timestamp // $event.eventTimestamp),
    level: "error",
    message: (($exception.name // "Error") + ": " + ($exception.message | message) + event_context($event))
  } end;

def first_app_log:
  . as $event
  | ($event.logs // [] | first) as $log
  | if $log == null then empty else ($log | structured_log | .timestamp = (.timestamp // $event.eventTimestamp)) end;

def first_diagnostic:
  . as $event
  | ($event.diagnosticsChannelEvents // [] | first) as $diagnostic
  | if $diagnostic == null then empty else {
    timestamp: ($diagnostic.timestamp // $diagnostic.message.timestamp // $event.eventTimestamp),
    level: "",
    message: ($diagnostic | diagnostics_message)
  } end;

. as $event
| if ($event | type) != "object" then empty else
  ([first_exception, first_app_log, platform_log, first_diagnostic] | first)
  | "\(.timestamp | timestamp)\t\(.level)\t\(.message)"
  end
