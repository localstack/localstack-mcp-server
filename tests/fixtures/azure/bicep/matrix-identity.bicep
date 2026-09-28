// L2 matrix fixture (tests/azure/matrix/resources.yaml): one user-assigned identity, the
// lightest resource the emulator creates (no side-car container). No registry modules.
param location string = resourceGroup().location
param name string = 'id-${uniqueString(resourceGroup().id)}'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
}

output principalId string = identity.properties.principalId
