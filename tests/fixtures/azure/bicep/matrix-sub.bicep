// L2 matrix fixture (tests/azure/matrix/resources.yaml): a subscription-scope deployment that
// creates nothing, so it leaves no resource behind on a shared emulator. No registry modules.
targetScope = 'subscription'

param label string = 'l2-matrix'

output label string = label
