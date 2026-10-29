# RxLocal fpx recipes

`R=~/.claude/skills/rxlocal-fpx/scripts/rxlocal`

## Who am I / IDs
```sh
$R profile | jq '{name: (.firstName+" "+.lastName), email: .emailAddress, patientId: .rxLocalPatientID}'
```

## Prescriptions / refills on file
```sh
$R refills                      # full list (passthrough until projected)
$R refills | jq 'length'        # how many
$R refills | jq '.[0] | keys'   # discover the row fields (use to finalize projection)
```

## Messages with the pharmacy
```sh
$R messages                     # recent messages (passthrough)
$R messages | jq 'length'
$R messages | jq '.[0] | keys'  # discover message fields
```

## Notifications banner
```sh
$R notifications
```

## Anything else (unprojected)
```sh
$R raw GET  account/getuserinfo
$R raw GET  'patients/GetPatientPharmacies?GroupOwnerID=<id>&RxLocalPatientId=<id>'
$R raw POST Messaging/EmployeeInfo '{"RxLocalPatientID":"<id>","GroupOwnerID":"<id>"}'
```

## Troubleshooting
- Exit `2`: bridge down — open/reload a signed-in `patient.rxlocal.com` tab in the
  browser running ContextMint Bridge.
- Exit `4` with "token aged out": the 5-minute token expired — reload the tab and
  retry immediately.
- Fresh pair codes printed on every call: a second browser's bridge is being
  turned away; don't approve them. `fpx trust list` shows which identity is pinned.
