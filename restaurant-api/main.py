from fastapi import FastAPIS
app = FastAPI()


@app.get("/")
def home():
    return {"message": "Restaurant API is running!"}